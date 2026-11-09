// ESM resolve hook for the child process. The instrumented copy of the user's file sits in a temp folder;
// this makes `import` inside it resolve as if it were the real file (its folder, then the workspace folders).
let D = { tmpUrl: '', origUrl: '', wsUrls: [] };
export async function initialize(data) { if (data) D = data; }
export async function resolve(specifier, context, next) {
  if (D.tmpUrl && context.parentURL === D.tmpUrl) {
    try {
      return await next(specifier, { ...context, parentURL: D.origUrl });
    } catch (e) {
      for (const u of D.wsUrls || []) {
        try { return await next(specifier, { ...context, parentURL: u }); } catch (_) { /* next folder */ }
      }
      throw e;
    }
  }
  return next(specifier, context);
}
