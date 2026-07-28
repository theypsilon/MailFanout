import { runMailFanout } from "./fanout";
import type { CronEvent, Env } from "./types";

export default {
  async scheduled(controller: CronEvent, env: Env): Promise<void> {
    console.log("Mail fanout run started", {
      cron: controller.cron,
      scheduledTime: new Date(controller.scheduledTime).toISOString(),
    });

    const result = await runMailFanout(env);
    console.log("Mail fanout run completed", result);
  },
};
