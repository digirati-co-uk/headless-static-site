import "../bun.ts";
import { Command } from "commander";
import { argv } from "process";
import { build } from "./commands/build";
import { serve } from "./commands/serve.ts";
import { validate } from "./commands/validate.ts";

const program = new Command();

program
  .command("build")
  .description("Build headless static site")
  .option("--no-cache", "Disable caching")
  .option("-w, --watch", "Watch for changes")
  .option("-s, --scripts <path>", "Build scripts")
  .option("--debug", "Debug")
  .option("--validate", "Validate config before building")
  .option("-e, --exact <path>", "Build single path only")
  .option("-c, --config <path>", "Path to config file")
  .option("--stores <name...>", "Names of stores to build")
  .option("--no-emit", "Disable emitting")
  .option("--no-extract", "Disable extraction")
  .option("--no-enrich", "Disable enrichment")
  .option("--no-client", "Disable client.js building")
  .option("--html", "Include HTML in build")
  .action(build);

program
  .command("serve")
  .description("Serve headless static site")
  .option("-d, --dev", "Development mode")
  .option("-s, --scripts <path>", "Build scripts")
  .action(serve);

program
  //
  .command("validate")
  .description("Validate config")
  .action(validate);

program.parse(argv);
