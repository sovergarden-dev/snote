declare module "cloudflare:workers" {
  export class DurableObject<Environment = unknown> {
    constructor(context: unknown, environment: Environment);
  }
}
