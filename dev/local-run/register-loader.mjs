// Redirects imports of "@neondatabase/serverless" to the local pg-backed
// mock so the no-build apps talk to local Postgres instead of Neon's proxy.
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register(new URL("./loader-hooks.mjs", import.meta.url), pathToFileURL("./"));
