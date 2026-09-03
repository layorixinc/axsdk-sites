import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  MANIFEST, attachBuild, createProfile, deleteProfile, detachBuild, listProfiles, profileRootFrom,
} from './src/ops/profiles.ts';

async function root() {
  const temp = await mkdtemp(join(tmpdir(), 'axde-profiles-'));
  return join(temp, 'profiles');
}

const never = () => false;

test('the profile root follows the harness environment, never a second convention', () => {
  assert.equal(profileRootFrom({ AXSDK_PROFILE_ROOT: 'D:/custom' }), 'D:/custom');
  assert.equal(
    profileRootFrom({ LOCALAPPDATA: 'C:/Users/x/AppData/Local' }),
    'C:/Users/x/AppData/Local/AXSDKChromeProfiles',
  );
});

test('creating a profile writes the manifest that makes it OURS', async () => {
  const base = await root();
  const created = await createProfile({ root: base, name: 'packdev', port: 39701 });
  assert.equal(created.name, 'packdev');
  const manifest = JSON.parse(await readFile(join(base, 'packdev', MANIFEST), 'utf8'));
  assert.equal(manifest.createdBy, 'axde');
  assert.equal(manifest.port, 39701);
  assert.match(manifest.createdAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('an unusable name is refused with the same rule the launcher uses', async () => {
  const base = await root();
  for (const name of ['', '  ', '..', 'a/b', 'a\\b']) {
    await assert.rejects(() => createProfile({ root: base, name, port: 1 }), /profile name/i, JSON.stringify(name));
  }
});

test('creating over an existing profile is refused rather than merged', async () => {
  const base = await root();
  await createProfile({ root: base, name: 'packdev', port: 39701 });
  await assert.rejects(() => createProfile({ root: base, name: 'packdev', port: 39702 }), /already exists/i);
});

test('the inventory labels a directory we did not create as FOREIGN', async () => {
  const base = await root();
  await createProfile({ root: base, name: 'packdev', port: 39701 });
  await mkdir(join(base, 'axsdk-extension-cdp'), { recursive: true });
  await writeFile(join(base, 'stray-file.txt'), 'not a profile');

  const rows = await listProfiles({ root: base, probe: never });
  assert.deepEqual(rows.map((row) => [row.name, row.kind]), [
    ['axsdk-extension-cdp', 'foreign'],
    ['packdev', 'axde'],
  ], 'sorted by name; a file is not a profile');
  assert.equal(rows.find((row) => row.name === 'packdev').port, 39701);
  assert.equal(rows.find((row) => row.name === 'axsdk-extension-cdp').port, undefined);
});

test('a missing root is an empty inventory, not a crash', async () => {
  assert.deepEqual(await listProfiles({ root: join(await root(), 'nope'), probe: never }), []);
});

test('chrome up/down is PROBED per profile, and only for a profile that records a port', async () => {
  const base = await root();
  await createProfile({ root: base, name: 'packdev', port: 39701 });
  await mkdir(join(base, 'foreignish'), { recursive: true });
  const asked = [];
  const probe = async (port) => { asked.push(port); return port === 39701; };

  const rows = await listProfiles({ root: base, probe });
  assert.deepEqual(asked, [39701], 'a profile with no recorded port is not probed');
  assert.equal(rows.find((row) => row.name === 'packdev').chrome, 'up');
  assert.equal(rows.find((row) => row.name === 'foreignish').chrome, 'down');
});

test('a corrupt manifest degrades to foreign instead of throwing', async () => {
  const base = await root();
  await mkdir(join(base, 'broken'), { recursive: true });
  await writeFile(join(base, 'broken', MANIFEST), '{ not json');
  const rows = await listProfiles({ root: base, probe: never });
  assert.equal(rows[0].kind, 'foreign');
});

test('deleting our own profile removes the directory', async () => {
  const base = await root();
  await createProfile({ root: base, name: 'packdev', port: 39701 });
  assert.deepEqual(await deleteProfile({ root: base, name: 'packdev' }), { name: 'packdev', removed: true });
  assert.deepEqual(await listProfiles({ root: base, probe: never }), []);
});

test('deleting a FOREIGN profile is refused unless forced — it may hold the developer\'s credentials', async () => {
  const base = await root();
  await mkdir(join(base, 'axsdk-extension-cdp'), { recursive: true });
  await assert.rejects(
    () => deleteProfile({ root: base, name: 'axsdk-extension-cdp' }),
    /axde did not create/i,
  );
  assert.equal((await listProfiles({ root: base, probe: never })).length, 1, 'still there');
  assert.deepEqual(
    await deleteProfile({ root: base, name: 'axsdk-extension-cdp', force: true }),
    { name: 'axsdk-extension-cdp', removed: true },
  );
});

test('deleting what is not there says so instead of reporting success', async () => {
  const base = await root();
  await assert.rejects(() => deleteProfile({ root: base, name: 'ghost' }), /no such profile/i);
});

test('a traversal cannot reach outside the root, on create or delete', async () => {
  const base = await root();
  const outside = join(base, '..', 'victim');
  await mkdir(outside, { recursive: true });
  await assert.rejects(() => deleteProfile({ root: base, name: '../victim', force: true }), /profile name/i);
  await rm(outside, { recursive: true, force: true });
});

test('a build is ATTACHED to the profile, because that is what makes it survive a restart', async () => {
  const base = await root();
  await createProfile({ root: base, name: 'packdev', port: 39701 });
  await attachBuild({ root: base, name: 'packdev', dist: 'D:/dist' });
  const manifest = JSON.parse(await readFile(join(base, 'packdev', MANIFEST), 'utf8'));
  assert.equal(manifest.dist, 'D:/dist');
  assert.equal(manifest.createdBy, 'axde', 'attaching never rewrites the rest of the manifest');
  assert.equal((await listProfiles({ root: base, probe: never }))[0].dist, 'D:/dist');
});

test('detaching removes the attachment so the next launch does not bring it back', async () => {
  const base = await root();
  await createProfile({ root: base, name: 'packdev', port: 39701 });
  await attachBuild({ root: base, name: 'packdev', dist: 'D:/dist' });
  await detachBuild({ root: base, name: 'packdev' });
  const manifest = JSON.parse(await readFile(join(base, 'packdev', MANIFEST), 'utf8'));
  assert.ok(!('dist' in manifest), 'absent, not empty');
  assert.equal((await listProfiles({ root: base, probe: never }))[0].dist, undefined);
});

test('attaching to a profile axde did not create is refused', async () => {
  const base = await root();
  await mkdir(join(base, 'axsdk-extension-cdp'), { recursive: true });
  await assert.rejects(
    () => attachBuild({ root: base, name: 'axsdk-extension-cdp', dist: 'D:/dist' }),
    /axde did not create/i,
  );
});
