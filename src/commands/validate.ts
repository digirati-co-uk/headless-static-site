import { Command } from "commander";
import { getConfig } from "../util/get-config.ts";
import {
  compileReverseSlugConfig,
  compileSlugConfig,
} from "../util/slug-engine.ts";
import chalk from "chalk";

interface ValidateOptions {}
export async function validate(options: ValidateOptions, command?: Command) {
  let didError = false;
  const config = await getConfig();
  if (config.slugs) {
    const slugs = Object.keys(config.slugs);
    for (const slugName of slugs) {
      const slug = config.slugs[slugName];
      if (!slug.examples) {
        didError = true;
        console.log(chalk.red`  - Slug ${slugName} is missing examples\n`);
        continue;
      }

      const compiled = compileSlugConfig(slug);
      const reverse = compileReverseSlugConfig(slug);

      for (const example of slug.examples) {
        const prefix = chalk.gray(`[${slugName}]`) + ` ${example}`;

        const [result] = compiled(example);
        if (!result) {
          didError = true;
          console.log(chalk.red(prefix), chalk.red` ⨯ failed to compile`);
          continue;
        }
        const [reverseResult] = reverse(result);
        if (!reverseResult || reverseResult !== example) {
          didError = true;
          console.log(chalk.red(prefix), chalk.red`⨯ failed to reverse`);
          console.log(
            `\n    Found:    ${reverseResult}\n    Expected: ${example} \n`,
          );
          continue;
        }

        console.log(chalk.green`✔ `, prefix);
      }
    }
  }
  console.log("");

  if (didError) {
    console.log("\n", chalk.red`⨯ Validation failed`);
    process.exit(1);
  }
}
