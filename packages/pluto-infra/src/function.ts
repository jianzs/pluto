import { ProvisionType, PlatformType, utils } from "@plutolang/base";
import { IFunctionInfra, FunctionOptions } from "@plutolang/pluto";
import { ImplClassMap } from "./utils";

// Construct a type for a class constructor. The key point is that the parameters of the constructor
// must be consistent with the client class of this resource type. Use this type to ensure that
// all implementation classes have the correct and same constructor signature.
type FunctionInfraImplClass = new (name: string, options?: FunctionOptions) => IFunctionInfra;

// Construct a map that contains all the implementation classes for this resource type.
// The final selection will be determined at runtime, and the class will be imported lazily.
const implClassMap = new ImplClassMap<IFunctionInfra, FunctionInfraImplClass>({
  [ProvisionType.Pulumi]: {
    [PlatformType.AWS]: async () => (await import("./aws")).Lambda,
    [PlatformType.K8s]: async () => (await import("./k8s")).ServiceLambda,
  },
});

/**
 * This is a factory class that provides an interface to create instances of this resource type
 * based on the target platform and provisioning engine.
 */
export abstract class Function {
  /**
   * Asynchronously creates an instance of the function infrastructure class. The parameters of this function
   * must be consistent with the constructor of both the client class and infrastructure class associated
   * with this resource type.
   */
  public static async createInstance(
    name: string,
    options?: FunctionOptions
  ): Promise<IFunctionInfra> {
    // TODO: ensure that the resource implementation class for the simulator has identical methods as those for the cloud.
    if (
      utils.currentPlatformType() === PlatformType.Simulator &&
      utils.currentEngineType() === ProvisionType.Simulator
    ) {
      return new (await import("./simulator")).SimFunction(name, options);
    }

    return implClassMap.createInstanceOrThrow(
      utils.currentPlatformType(),
      utils.currentEngineType(),
      name,
      options
    );
  }
}
