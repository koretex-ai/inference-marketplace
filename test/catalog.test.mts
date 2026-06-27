// Model catalog filtering: the installer/preflight rely on this to show only models a Mac can run.
const PORT = process.env.PORT ?? "8790";
const HTTP = `http://127.0.0.1:${PORT}`;
let failures = 0;
const check = (cond: boolean, name: string) => {
  if (cond) console.log(`  ✓ ${name}`);
  else { console.error(`  ✗ ${name}`); failures++; }
};

const full = await (await fetch(`${HTTP}/models/catalog`)).json();
check(Array.isArray(full.models) && full.models.some((m: any) => m.primary), "catalog returns models including a primary");
check(full.models.every((m: any) => typeof m.type === "string"), "every model is classified by type");
check([...new Set(full.models.map((m: any) => m.type))].length >= 2, "catalog spans multiple model types");

const small = (await (await fetch(`${HTTP}/models/catalog?format=text&ram=8&disk=200`)).text()).trim();
check(small.split("\n").length === 1 && small.includes("llama3.2:3b"), "ram=8 → only the small model fits");
check(small.split("|").length === 4, "text rows carry tag|name|size|type");

const mid = (await (await fetch(`${HTTP}/models/catalog?format=text&ram=16&disk=200`)).text()).trim().split("\n");
check(mid[0].startsWith("gemma3:12b-it-qat"), "primary model is listed first");
check(mid.length >= 2, "ram=16 fits multiple models");

const diskGated = await (await fetch(`${HTTP}/models/catalog?format=text&ram=256&disk=15`)).text();
check(!diskGated.includes("llama3.3:70b"), "disk gate excludes models that won't fit on disk");

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nmodel catalog filtering: all checks passed");
