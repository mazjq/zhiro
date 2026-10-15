/**
 * How many tokens does filling one form cost? Replays the model step of a saved run (the only model call a run makes:
 * sorting out the fields the rule dictionary does not know) against the real model, and prints the usage.
 *   node --import tsx src/cli/measure-form.ts <runs/apply/<id>.json>
 * Only field labels, sections, types and options are sent — never the user's values. Reads the database read-only.
 */
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { loadConfig, dbPath } from "../config.js";
import { createLlm } from "../llm.js";
import { mapFields, type FormField } from "../service/apply.js";

const file = process.argv[2];
if (!file) throw new Error("usage: measure-form.ts <run json>");
const config = loadConfig();
const db = new DatabaseSync(dbPath(config.vault), { readOnly: true });
const llm = createLlm(config);
const calls: any[] = [];
llm.onUsage = (m: any) => calls.push(m.usage);
const run = JSON.parse(readFileSync(file, "utf8"));
const fields: FormField[] = run.form.map((f: any, i: number) => ({ index: i, local: i, frame: "", section: f.section ?? "", label: f.label ?? "", type: f.type, required: false, options: [], value: "", placeholder: "", name: "" }));
const t = Date.now();
const mapped = await mapFields(db as any, llm, fields);
const byModel = mapped.filter((m) => m.how === "模型").length, byRule = mapped.filter((m) => m.how === "规则").length;
const sum = (k: string) => calls.reduce((n, u) => n + (u?.[k] ?? 0), 0);
console.log(JSON.stringify({ form: run.title, fields: fields.length, byRule, byModel, modelCalls: calls.length, input: sum("input"), output: sum("output"), reasoning: sum("reasoning"), total: sum("totalTokens"), cost: calls.reduce((n, u) => n + (u?.cost?.total ?? 0), 0), seconds: (Date.now() - t) / 1000, model: `${config.llm.provider}/${config.llm.model}` }, null, 1));
