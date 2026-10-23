/**
 * dsh-plugin-neighbour — a stand-in neighbour for the suite's real-DSH
 * tests. Its host half does nothing; its browser half (lib/client.js) puts
 * one entry in each place the suite's plugins draw in DSH's window.
 *
 * @module dsh-plugin-neighbour
 */
export const name = 'neighbour';
export const inject = [];
export function apply() {}
