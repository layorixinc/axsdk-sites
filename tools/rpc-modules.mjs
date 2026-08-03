// Uploads built Lua modules into a session's registry (`POST /axsdk/v2/lua`), the other half of a
// registry-delivery build: the document names modules, this puts the sources where the runtime looks.
//
// Resolution order on the server is app package → session registry, and a session upload REPLACES a
// packaged module of the same name. That is what makes this the development loop — the deployed package
// stays untouched while the working copy runs.

/**
 * @param {object} options
 * @param {Record<string, string>} options.modules  module name → Lua source, in declaration order
 * @param {string} options.baseUrl                  backend origin
 * @param {Record<string, string>} options.headers  auth + `x-app-user-session-id`
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {Promise<{ uploaded: string[], bytes: number }>}
 */
export async function uploadModules({ modules, baseUrl, headers, fetchImpl = fetch }) {
  const uploaded = [];
  let bytes = 0;

  for (const [name, source] of Object.entries(modules)) {
    const response = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/axsdk/v2/lua`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ name, source }),
    });

    if (!response.ok) {
      const detail = await readDetail(response);
      // The session is now holding a partial set. Saying which modules made it is the difference between
      // "retry the upload" and "this session will fail with a missing function you cannot grep for".
      const error = new Error(`module '${name}' was refused (${response.status}): ${detail}`);
      error.uploaded = uploaded;
      error.failed = name;
      throw error;
    }

    uploaded.push(name);
    bytes += Buffer.byteLength(source, 'utf8');
  }

  return { uploaded, bytes };
}

async function readDetail(response) {
  try {
    const body = await response.json();
    return [body?.code, body?.message].filter(Boolean).join(': ') || JSON.stringify(body);
  } catch {
    return 'no readable body';
  }
}
