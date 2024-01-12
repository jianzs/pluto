import { engine, runtime, utils } from "@plutolang/base";
import { IScheduleInfraApi, IScheduleCapturedProps, ScheduleOptions } from "@plutolang/pluto";
import { ImplClassMap } from "./utils";

// Construct a type that includes all the necessary methods required to be implemented within
// the infrastructure class of a resource type.
type IScheduleInfra = IScheduleInfraApi & IScheduleCapturedProps;

// Construct a type for a class constructor. The key point is that the parameters of the constructor
// must be consistent with the client class of this resource type. Use this type to ensure that
// all implementation classes have the correct and same constructor signature.
type ScheduleInfraImplClass = new (name: string, options?: ScheduleOptions) => IScheduleInfra;

// Construct a map that contains all the implementation classes for this resource type.
// The final selection will be determined at runtime, and the class will be imported lazily.
const implClassMap = new ImplClassMap<IScheduleInfra, ScheduleInfraImplClass>({
  [engine.Type.pulumi]: {
    [runtime.Type.AWS]: async () => (await import("./aws")).CloudWatchSchedule,
    [runtime.Type.K8s]: async () => (await import("./k8s")).PingSchedule,
  },
});

/**
 * This is a factory class that provides an interface to create instances of this resource type
 * based on the target platform and engine.
 */
export abstract class Schedule {
  /**
   * Asynchronously creates an instance of the schedule infrastructure class. The parameters of this function
   * must be consistent with the constructor of both the client class and infrastructure class associated
   * with this resource type.
   */
  public static async createInstance(
    name: string,
    options?: ScheduleOptions
  ): Promise<IScheduleInfra> {
    return implClassMap.createInstanceOrThrow(
      utils.currentPlatformType(),
      utils.currentEngineType(),
      name,
      options
    );
  }
}