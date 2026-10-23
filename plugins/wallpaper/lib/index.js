// Wallpaper and glass — host entry. Kept tiny on purpose: it loads impl.js with a fresh URL each time the plugin is
// (re)enabled, so turning the plugin off and on in Settings → Plugins picks up new host code without a restart.
export const name = 'wallpaper';
export const inject = [];
export async function apply(ctx, config) {
  const impl = await import(new URL(`./impl.js?v=${Date.now()}`, import.meta.url).href);
  return impl.apply(ctx, config);
}
