/** DSH's data folder for a test: CANON_TEST_DSH_HOME. */
import { join } from 'node:path';

export const resolveDshHome = () => process.env.CANON_TEST_DSH_HOME;
export const dshHomePath = (...parts) => join(process.env.CANON_TEST_DSH_HOME, ...parts);
