import { extract } from "../lib/scripts";

extract(
  {
    name: "testing js extract",
    types: ["Manifest"],
  },
  async (resource, api) => {
    return {};
  },
);
