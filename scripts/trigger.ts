import { helloWorld } from "../src/hello.ts";

helloWorld({
  source: "github-actions",
  scheduledTime: new Date().toISOString(),
});

