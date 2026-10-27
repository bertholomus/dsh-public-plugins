// Reasoning pill — host entry. The plugin is all client side (lib/client.js): it keeps no data, writes no files and
// adds no routes. The host half exists only so DSH can load the bundle.
export const name = 'reasoning-pill';
export const inject = [];
export function apply() {}
