import { Command } from "commander";
import { argv } from "process";
import { build } from "./commands/build";
import { serve } from "./commands/serve.ts";

const program = new Command();

program
  .command("build")
  .description("Build headless static site")
  .option("--no-cache", "Disable caching")
  .option("-w, --watch", "Watch for changes")
  .option("-s, --scripts <path>", "Build scripts")
  .option("--debug", "Debug")
  .option("-e, --exact <path>", "Build single path only")
  .option("-c, --config <path>", "Path to config file")
  .option("--stores <name...>", "Names of stores to build")
  .action(build);

program
  .command("serve")
  .description("Serve headless static site")
  .action(serve);

program.parse(argv);
