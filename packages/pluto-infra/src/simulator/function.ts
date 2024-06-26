import { simulator } from "@plutolang/base";
import { AnyFunction, FunctionOptions, IFunctionClient } from "@plutolang/pluto";
import { ComputeClosure } from "@plutolang/base/closure";

export class SimFunction implements simulator.IResourceInstance, IFunctionClient<AnyFunction> {
  private readonly closure: ComputeClosure<AnyFunction>;

  constructor(handler: ComputeClosure<AnyFunction>, name?: string, options?: FunctionOptions) {
    this.closure = handler;
    name;
    options;
  }

  public url(): string {
    throw new Error("The simulator function URL is currently not supported.");
  }

  public addEventHandler(op: string, args: any[]): void {
    op;
    args;
    throw new Error("Method should not be called.");
  }

  public async cleanup(): Promise<void> {}

  public async invoke(...payload: any[]): Promise<any> {
    return await this.closure(...payload);
  }
}
