interface HelloWorldContext {
  readonly source: string;
  readonly cron?: string;
  readonly scheduledTime: string;
}

export function helloWorld(context: HelloWorldContext): void {
  console.log("Hello, World!", context);
}
