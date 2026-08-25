AXSDK.register({
  commands: {
    read_heading: async () => ({
      heading: document.querySelector('h1')?.textContent?.trim() ?? null,
    }),

    // `AXSDK.storage` is the extension's, not the page's: it survives the navigation that destroys
    // this world, and the site cannot read or clear it the way it can clear `localStorage`.
    remember: async (input) => {
      await AXSDK.storage.set('note', input.note);
      return { stored: true };
    },

    // `AXSDK.net.fetch` reaches only the hosts this release declares and the user approved.
    ping_api: async () => {
      const answer = await AXSDK.net.fetch('https://api.axsdk.ai/health');
      return { status: answer.status };
    },

    probe_forbidden: async () => {
      try {
        await AXSDK.net.fetch('https://undeclared.example/x');
        return { refused: false };
      } catch (error) {
        return { refused: true, message: String(error?.message ?? error) };
      }
    },

    recall: async () => ({
      note: await AXSDK.storage.get('note'),
      keys: await AXSDK.storage.list(),
    }),
  },
});
