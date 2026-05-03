import { loadConfig } from "./config.ts";

async function main() {
  const config = await loadConfig();
  console.log("my-claw started", { channels: Object.keys(config.channels) });
}

main().catch(console.error);
