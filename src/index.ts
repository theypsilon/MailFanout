import { executeMailFanout } from "./run";
import type { CronEvent, Env } from "./types";

export default {
  async scheduled(controller: CronEvent, env: Env): Promise<void> {
    await executeMailFanout(env, {
      trigger: "cloudflare-cron",
      cron: controller.cron,
      scheduledTime: controller.scheduledTime,
    });
  },
};
