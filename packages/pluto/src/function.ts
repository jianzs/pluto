import {
  IResource,
  IResourceCapturedProps,
  IResourceInfraApi,
  runtime,
  simulator,
} from "@plutolang/base";
import { IResourceClientApi } from "@plutolang/base";

export interface IFunctionCapturedProps extends IResourceCapturedProps {}

export interface IFunctionInfraApi extends IResourceInfraApi {}

export interface IFunctionClientApi extends IResourceClientApi {
  invoke(payload: string): Promise<string>;
}

export interface FunctionOptions {
  envs?: Record<string, any>;
}

export class Function implements IResource {
  constructor(name: string, opts?: FunctionOptions) {
    name;
    opts;
    throw new Error(
      "Cannot instantiate this class, instead of its subclass depending on the target runtime."
    );
  }

  public static buildClient(name: string, opts?: FunctionOptions): IFunctionClientApi {
    const rtType = process.env["RUNTIME_TYPE"];
    switch (rtType) {
      case runtime.Type.Simulator:
        opts;
        if (!process.env.PLUTO_SIMULATOR_URL) throw new Error("PLUTO_SIMULATOR_URL doesn't exist");
        return simulator.makeSimulatorClient(process.env.PLUTO_SIMULATOR_URL!, name);
      default:
        throw new Error(`not support this runtime '${rtType}'`);
    }
  }
}

export interface Function
  extends IFunctionClientApi,
    IFunctionInfraApi,
    IFunctionCapturedProps,
    IResource {}
