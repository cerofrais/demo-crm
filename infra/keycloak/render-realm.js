// Render realm-export.template.json → realm-export.json by substituting
// ${VAR} placeholders with process.env values. Run once by the
// `keycloak-realm-render` compose service before Keycloak starts.
//
// Lives as a file (not an inline entrypoint) because YAML folded scalars
// mangled the regex escapes when this ran inline, producing a no-op
// substitution that left the seeded admin's password as the literal string
// "${SEED_ADMIN_PASSWORD}".
const fs = require("fs");

const TEMPLATE = "/template/realm-export.template.json";
const OUT = "/import/realm-export.json";

const src = fs.readFileSync(TEMPLATE, "utf8");
const missing = new Set();
const out = src.replace(/\$\{(\w+)\}/g, (match, name) => {
  const val = process.env[name];
  if (val === undefined || val === "") {
    missing.add(name);
    return match;
  }
  return val;
});

if (missing.size > 0) {
  console.error(
    `render-realm: refusing to write — required env vars unset: ${[...missing].join(", ")}`,
  );
  process.exit(1);
}

fs.writeFileSync(OUT, out);
console.log("rendered realm-export.json");
