import { readFile } from "node:fs/promises";
import { parquetReadObjects, parquetMetadataAsync } from "hyparquet";

function stringify(v: unknown): string {
  return JSON.stringify(v, (_k, val) => (typeof val === "bigint" ? val.toString() : val), 2);
}

async function inspect(path: string, label: string) {
  const buf = await readFile(path);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const meta = await parquetMetadataAsync(ab);
  console.log(`\n=== ${label} ===`);
  console.log("linhas:", meta.num_rows, "| colunas:", meta.schema.map((s: any) => s.name).filter((n: string) => n !== "schema").join(", "));
  const rows = (await parquetReadObjects({ file: ab, rowStart: 0, rowEnd: 3 })) as any[];
  for (const r of rows) console.log(stringify(r));
}

const before = process.memoryUsage().rss;
await inspect("./data/revlogs10k-sample/revlogs_user1.parquet", "revlogs (user_id=1)");
await inspect("./data/revlogs10k-sample/cards_user1.parquet", "cards (user_id=1)");
await inspect("./data/revlogs10k-sample/decks_user1.parquet", "decks (user_id=1)");
const after = process.memoryUsage().rss;
console.log(`\nRSS antes=${(before / 1e6).toFixed(1)}MB depois=${(after / 1e6).toFixed(1)}MB delta=${((after - before) / 1e6).toFixed(1)}MB`);
