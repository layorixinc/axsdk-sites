#!/usr/bin/env node
// Full-extension live tests for the explicit _common memory flow.
// Uses the shared CDP harness, syncs local Lua + flows into extension stores, drives AXSDK.sendMessage,
// and verifies both the visible reply/tool trace and the persisted SDK memory state.
//
// Usage:
//   node _common/scripts/test_memory_flow.mjs
//   node _common/scripts/test_memory_flow.mjs --only=save
//   node _common/scripts/test_memory_flow.mjs --no-sync
import assert from 'node:assert/strict';
import {
  SITE_HOME,
  resolveOptions,
  ensureChrome,
  attachActive,
  openPage,
  callInAxContext,
  syncStore,
  sendMessage,
  reloadExtension,
} from '../../tools/harness/cdp.mjs';

const arg = (name, fallback = '') => {
  const found = process.argv.find(value => value.startsWith(`${name}=`));
  return found ? found.slice(name.length + 1) : fallback;
};
const has = name => process.argv.includes(name);
const ONLY = arg('--only');
const SYNC = !has('--no-sync');
const TIMEOUT = Number(arg('--timeout', '180000'));

const options = resolveOptions({
  match: 'thumbtack.com',
  site: 'thumbtack',
  ...(process.env.CDP_URL ? { cdp: process.env.CDP_URL } : {}),
});

let activeCdpUrl;

const RESET = `function(seed) {
  const a = globalThis._AXSDK || globalThis.AXSDK;
  if (!a) throw new Error('AXSDK unavailable');
  const chat = a.getChatStore().getState();
  try { chat.setSession && chat.setSession(undefined); } catch {}
  try { chat.setMessages && chat.setMessages([]); } catch {}
  try { chat.setQuestions && chat.setQuestions(null); } catch {}
  try { chat.setSessionClosed && chat.setSessionClosed(false); } catch {}
  try { a.getErrorStore && a.getErrorStore().getState().clearErrors(); } catch {}
  const memory = a.getMemoryStore().getState();
  memory.clearMemory();
  for (const [key, value] of Object.entries(seed || {})) {
    const result = a.setMemory(key, value);
    if (!result || result.ok !== true) throw new Error('seed failed for ' + key + ': ' + JSON.stringify(result));
  }
  return { keys: Object.keys(a.getMemoryStore().getState().memory) };
}`;

const READ_MEMORY = `function(keys) {
  const a = globalThis._AXSDK || globalThis.AXSDK;
  return Object.fromEntries((keys || []).map(key => [key, a.getMemory(key) ?? null]));
}`;

function toolLeaf(name) {
  return String(name || '').split('.').pop();
}

function memoryToolParts(turn) {
  const names = new Set(['list_memory', 'get_memory', 'search_memory', 'find_delete_candidates', 'set_memory', 'delete_memory']);
  return (turn.parts || []).filter(part => part.type === 'tool' && names.has(toolLeaf(part.tool)));
}

function toolOutput(turn, expected) {
  const part = memoryToolParts(turn).find(candidate => toolLeaf(candidate.tool) === expected);
  assert.equal(part?.status, 'completed');
  return part?.output?.memory_result ?? part?.output;
}

function hasTool(turn, name) {
  return (turn.parts || []).some(part => part.type === 'tool' && part.tool === name);
}

function assertCandidateReply(turn) {
  assert.match(turn.reply, /address/);
  assert.match(turn.reply, /shipping_address/);
  assert.match(turn.reply, /삭제|선택|어떤|which|\?/i);
}

async function reset(page, seed = {}) {
  await callInAxContext(page, options, RESET, [seed]);
}

async function memory(page, ...keys) {
  return callInAxContext(page, options, READ_MEMORY, [keys]);
}

async function runTurn(page, text) {
  const turn = await sendMessage({ page, options }, text, { timeoutMs: TIMEOUT });
  console.log(`\nUSER: ${text}`);
  console.log(`REPLY: ${turn.reply}`);
  console.log('TOOLS:', memoryToolParts(turn).map(part => ({ tool: toolLeaf(part.tool), status: part.status, output: part.output })));
  return turn;
}

const scenarios = [
  {
    id: 'save',
    async run(page) {
      await reset(page);
      const turn = await runTurn(page, '내 이메일 thumbtack-test@example.com을 기억해');
      assert.deepEqual(memoryToolParts(turn).map(part => toolLeaf(part.tool)), ['set_memory']);
      assert.equal((await memory(page, 'email')).email, 'thumbtack-test@example.com');
      assert.match(turn.reply, /email|이메일/i);
    },
  },
  {
    id: 'mixed',
    async run(page) {
      await reset(page, { address: '123 Test St', phone: '415-555-0100' });
      const turn = await runTurn(page, '이메일 thumbtack-test@example.com을 기억하고 address는 잊어줘');
      assert.deepEqual(memoryToolParts(turn).map(part => toolLeaf(part.tool)), ['set_memory']);
      const values = await memory(page, 'email', 'address', 'phone');
      assert.equal(values.email, 'thumbtack-test@example.com');
      assert.equal(values.address, null);
      assert.equal(values.phone, '415-555-0100');
      const output = toolOutput(turn, 'set_memory');
      assert.deepEqual(output?.saved, ['email']);
      assert.deepEqual(output?.removed, ['address']);
    },
  },
  {
    id: 'get',
    async run(page) {
      await reset(page, { email: 'thumbtack-test@example.com' });
      const turn = await runTurn(page, '내 이메일이 뭐야?');
      assert.deepEqual(memoryToolParts(turn).map(part => toolLeaf(part.tool)), ['get_memory']);
      assert.match(turn.reply, /thumbtack-test@example\.com/i);
    },
  },
  {
    id: 'search',
    async run(page) {
      await reset(page, { 'project/alpha': '# Project Alpha\n\n- Migration rehearsal comes before deployment.' });
      const turn = await runTurn(page, '프로젝트 알파 관련 기억을 찾아줘');
      assert.deepEqual(memoryToolParts(turn).map(part => toolLeaf(part.tool)), ['search_memory']);
      const output = toolOutput(turn, 'search_memory');
      assert.deepEqual(output?.keys, ['project/alpha']);
      assert.match(String(output?.markdown || ''), /Migration rehearsal/i);
    },
  },
  {
    id: 'list',
    async run(page) {
      await reset(page, { email: 'thumbtack-test@example.com', phone: '415-555-0100' });
      const turn = await runTurn(page, '기억하고 있는 key 목록을 보여줘');
      assert.deepEqual(memoryToolParts(turn).map(part => toolLeaf(part.tool)), ['list_memory']);
      assert.match(turn.reply, /email/i);
      assert.match(turn.reply, /phone/i);
    },
  },
  {
    id: 'no-auto-capture',
    async run(page) {
      await reset(page);
      const turn = await runTurn(page, '내 이메일은 thumbtack-test@example.com이야');
      assert.equal((await memory(page, 'email')).email, null);
      assert.equal(memoryToolParts(turn).length, 0);
    },
  },
  {
    id: 'quote-no-memory-read',
    async run(page) {
      await reset(page, { email: 'thumbtack-test@example.com' });
      const turn = await runTurn(
        page,
        '94101에서 핸디맨 견적 받아줘. 요구사항은 내일 문 수리. 이름 Test, 성 User, 전화 415-555-0100.',
      );
      assert.equal(hasTool(turn, 'request_service_quote.collect_request'), true);
      assert.equal(memoryToolParts(turn).length, 0);
      assert.match(turn.reply, /email|이메일/i);
      assert.equal((await memory(page, 'email')).email, 'thumbtack-test@example.com');
    },
  },
  {
    id: 'shopping-route',
    async run(page) {
      await reset(page);
      const turn = await runTurn(page, '온라인에서 상품을 사고 싶어. 무엇을 살지는 아직 안 정했어.');
      assert.equal(hasTool(turn, 'shopping_single_site.collect_shopping'), true);
      assert.equal(memoryToolParts(turn).length, 0);
      assert.match(turn.reply, /무엇|상품|제품|품목|what/i);
    },
  },
  {
    id: 'ambiguous-delete',
    async run(page) {
      await reset(page, { address: '123 Test St', shipping_address: '456 Test Ave' });
      const first = await runTurn(page, '주소 관련 기억을 지워줘');
      assert.deepEqual(memoryToolParts(first).map(part => toolLeaf(part.tool)), ['find_delete_candidates']);
      let values = await memory(page, 'address', 'shipping_address');
      assert.equal(values.address, '123 Test St');
      assert.equal(values.shipping_address, '456 Test Ave');
      assertCandidateReply(first);

      const second = await runTurn(page, '배송 주소');
      assert.deepEqual(memoryToolParts(second).map(part => toolLeaf(part.tool)), ['delete_memory']);
      const output = toolOutput(second, 'delete_memory');
      assert.deepEqual(output?.removed, ['shipping_address']);
      assert.deepEqual(output?.not_found, []);
      values = await memory(page, 'address', 'shipping_address');
      assert.equal(values.address, '123 Test St');
      assert.equal(values.shipping_address, null);
    },
  },
  {
    id: 'direct-delete',
    async run(page) {
      await reset(page, { address: '123 Test St', phone: '415-555-0100' });
      const turn = await runTurn(page, 'address를 잊어줘');
      assert.deepEqual(memoryToolParts(turn).map(part => toolLeaf(part.tool)), ['delete_memory']);
      const output = toolOutput(turn, 'delete_memory');
      assert.deepEqual(output?.removed, ['address']);
      const values = await memory(page, 'address', 'phone');
      assert.equal(values.address, null);
      assert.equal(values.phone, '415-555-0100');
    },
  },
  {
    id: 'multiple-delete',
    async run(page) {
      await reset(page, { address: '123 Test St', shipping_address: '456 Test Ave' });
      const first = await runTurn(page, '주소 관련 기억을 지워줘');
      assert.deepEqual(memoryToolParts(first).map(part => toolLeaf(part.tool)), ['find_delete_candidates']);
      assertCandidateReply(first);
      const second = await runTurn(page, '둘 다');
      assert.deepEqual(memoryToolParts(second).map(part => toolLeaf(part.tool)), ['delete_memory']);
      const output = toolOutput(second, 'delete_memory');
      assert.deepEqual(output?.removed, ['address', 'shipping_address']);
      const values = await memory(page, 'address', 'shipping_address');
      assert.equal(values.address, null);
      assert.equal(values.shipping_address, null);
    },
  },
  {
    id: 'delete-cancel',
    async run(page) {
      await reset(page, { address: '123 Test St', shipping_address: '456 Test Ave' });
      const first = await runTurn(page, '주소 관련 기억을 지워줘');
      assert.deepEqual(memoryToolParts(first).map(part => toolLeaf(part.tool)), ['find_delete_candidates']);
      assertCandidateReply(first);
      const second = await runTurn(page, '삭제하지 마');
      assert.equal(memoryToolParts(second).length, 0);
      assert.match(second.reply, /취소|삭제하지|cancel/i);
      const values = await memory(page, 'address', 'shipping_address');
      assert.equal(values.address, '123 Test St');
      assert.equal(values.shipping_address, '456 Test Ave');
    },
  },
  {
    id: 'delete-ambiguous-retry',
    async run(page) {
      await reset(page, { address: '123 Test St', shipping_address: '456 Test Ave' });
      const first = await runTurn(page, '주소 관련 기억을 지워줘');
      assert.deepEqual(memoryToolParts(first).map(part => toolLeaf(part.tool)), ['find_delete_candidates']);
      assertCandidateReply(first);
      const second = await runTurn(page, '주소');
      assert.equal(memoryToolParts(second).length, 0);
      assert.match(second.reply, /address|주소/i);
      let values = await memory(page, 'address', 'shipping_address');
      assert.equal(values.address, '123 Test St');
      assert.equal(values.shipping_address, '456 Test Ave');

      const third = await runTurn(page, 'address');
      assert.deepEqual(memoryToolParts(third).map(part => toolLeaf(part.tool)), ['delete_memory']);
      values = await memory(page, 'address', 'shipping_address');
      assert.equal(values.address, null);
      assert.equal(values.shipping_address, '456 Test Ave');
    },
  },
  {
    id: 'delete-restart-resume',
    async run(page) {
      await reset(page, { address: '123 Test St', shipping_address: '456 Test Ave' });
      const first = await runTurn(page, '주소 관련 기억을 지워줘');
      assert.deepEqual(memoryToolParts(first).map(part => toolLeaf(part.tool)), ['find_delete_candidates']);
      assertCandidateReply(first);

      const restarted = await reloadExtension(activeCdpUrl, options, { url: SITE_HOME.thumbtack });
      const resumedPage = restarted.page;
      try {
        const second = await runTurn(resumedPage, '배송 주소');
        assert.deepEqual(memoryToolParts(second).map(part => toolLeaf(part.tool)), ['delete_memory']);
        const values = await memory(resumedPage, 'address', 'shipping_address');
        assert.equal(values.address, '123 Test St');
        assert.equal(values.shipping_address, null);
      } finally {
        resumedPage.close();
      }
    },
  },
];

async function main() {
  const chrome = await ensureChrome(options, { launch: true });
  activeCdpUrl = chrome.cdpUrl;
  const cdpUrl = activeCdpUrl;
  let attached;
  try {
    attached = await attachActive(cdpUrl, options, { match: options.match });
  } catch {
    const page = await openPage(cdpUrl, SITE_HOME.thumbtack);
    attached = { page };
  }
  const page = attached.page;
  try {
    if (SYNC) {
      const synced = await syncStore({ page, options }, { site: 'thumbtack', build: true, reload: true });
      console.log('SYNC:', JSON.stringify({
        fromStore: synced.fromStore,
        fromRemote: synced.fromRemote,
        clientFlows: synced.appliedClientFlows,
        flowKeys: synced.appliedFlowsStoreKeys,
      }));
      assert.equal(synced.fromRemote, 0);
      assert.equal(synced.appliedClientFlows?.remoteSites, false);
      assert.equal(synced.appliedClientFlows?.stored, true);
    }

    let count = 0;
    for (const scenario of scenarios) {
      if (ONLY && scenario.id !== ONLY) continue;
      console.log(`\n===== ${scenario.id} =====`);
      await scenario.run(page);
      console.log(`PASS ${scenario.id}`);
      count += 1;
    }
    if (count === 0) throw new Error(`unknown --only scenario: ${ONLY}`);
    console.log(`\nPASS ${count} flow scenario(s)`);
  } finally {
    page.close();
  }
}

main().catch(error => {
  console.error(`FAIL: ${error?.stack || error}`);
  process.exitCode = 1;
});
