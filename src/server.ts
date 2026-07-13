import { createServer } from "./create-server";
import { resolveConfigSource } from "./util/get-config";

const projectRoot = process.cwd();
const resolvedConfigSource = await resolveConfigSource(undefined, projectRoot);
const { config, ...configSource } = resolvedConfigSource;

export default await createServer(config, { configSource, projectRoot });
