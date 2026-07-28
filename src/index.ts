import { helloWorld } from "./hello";

interface CronEvent {
  readonly cron: string;
  readonly scheduledTime: number;
}

export default {
  async scheduled(controller: CronEvent): Promise<void> {
    helloWorld({
      source: "cloudflare-cron",
      cron: controller.cron,
      scheduledTime: new Date(controller.scheduledTime).toISOString(),
    });
  },
};
