import fs from "node:fs";

const barrelPath = new URL("../lib/api-zod/src/index.ts", import.meta.url);
fs.writeFileSync(
  barrelPath,
  'export * from "./generated/api";\nexport * as ApiTypes from "./generated/types";\n',
);
