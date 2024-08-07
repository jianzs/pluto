import * as path from "path";
import * as fs from "fs-extra";
import { table, TableUserConfig } from "table";
import { confirm } from "@inquirer/prompts";
import { arch, config, core, ProvisionType } from "@plutolang/base";
import logger from "../log";
import { loadAndDeduce, loadAndGenerate } from "./compile";
import {
  buildAdapter,
  buildAdapterByProvisionType,
  getDefaultDeducerPkg,
  getDefaultEntrypoint,
  loadArchRef,
  loadProjectAndStack,
  loadProjectRoot,
  stackStateFile,
} from "./utils";
import { dumpStackState, prepareStackDirs } from "../utils";
import { loadDotEnvs } from "./env";

export interface DeployOptions {
  stack?: string;
  deducer?: string;
  generator: string;
  apply: boolean;
  yes: boolean;
  force: boolean;
}

export async function deploy(entrypoint: string, opts: DeployOptions) {
  try {
    const projectRoot = loadProjectRoot();
    const { project, stack } = loadProjectAndStack(projectRoot, opts.stack);

    // Load the environment variables from the `.env` files.
    loadDotEnvs(projectRoot, stack.name, false);

    // Prepare the directories for the stack.
    const { baseDir, closuresDir, generatedDir, stateDir } = await prepareStackDirs(
      projectRoot,
      stack.name
    );

    // Ensure the entrypoint exist.
    entrypoint = entrypoint ?? getDefaultEntrypoint(project.language);
    if (!fs.existsSync(entrypoint)) {
      throw new Error(`No such file, ${entrypoint}`);
    }

    const { archRef, infraEntrypoint } = await buildArchRefAndInfraEntrypoint(
      project,
      stack,
      entrypoint,
      opts,
      closuresDir,
      generatedDir
    );

    // Save the filepath to the arch ref and the infra entrypoint in the stack state file.
    const archRefFile = path.join(baseDir, "arch.yml");
    fs.writeFileSync(archRefFile, archRef.toYaml());
    stack.archRefFile = archRefFile;
    stack.provisionFile = infraEntrypoint;
    dumpStackState(stackStateFile(stateDir), stack.state);

    const newAdapterArgs: core.NewAdapterArgs = {
      project: project.name,
      extraConfigs: project.configs,
      rootpath: project.rootpath,
      language: project.language,
      stack: stack,
      archRef: archRef,
      entrypoint: infraEntrypoint!,
      stateDir: stateDir,
    };

    const adapter =
      stack.provisionType === ProvisionType.Custom
        ? await buildAdapter(project.configs["adapter"], newAdapterArgs)
        : await buildAdapterByProvisionType(stack.provisionType, newAdapterArgs);

    await deployWithAdapter(adapter, stack, opts.force);

    // Save the stack state after the deployment.
    dumpStackState(stackStateFile(stateDir), stack.state);
  } catch (e) {
    if (e instanceof Error) {
      logger.error(e.message);
      if (process.env.DEBUG) {
        logger.error(e.stack);
      }
    } else {
      logger.error(e);
    }
    process.exit(1);
  }
}

/**
 * @param entrypoint - The entrypoint file of the user code.
 * @param closuresDir - The directory stores the closures deduced by the deducer.
 * @param generatedDir - The directory stores the files generated by the generator.
 */
async function buildArchRefAndInfraEntrypoint(
  project: config.Project,
  stack: config.Stack,
  entrypoint: string,
  options: DeployOptions,
  closuresDir: string,
  generatedDir: string
) {
  let archRef: arch.Architecture | undefined;
  let infraEntrypoint: string | undefined;

  const basicArgs: core.BasicArgs = {
    project: project.name,
    stack: stack,
    rootpath: project.rootpath,
  };

  // No deduction or generation, only application.
  if (!options.apply) {
    // construct the arch ref from user code
    logger.info("Generating reference architecture...");
    const deduceResult = await loadAndDeduce(
      getDefaultDeducerPkg(project.language, options.deducer),
      {
        ...basicArgs,
        closureDir: closuresDir,
      },
      [entrypoint]
    );
    archRef = deduceResult.archRef;

    const confirmed = await confirmArch(archRef, options.yes);
    if (!confirmed) {
      logger.info("You can modify your code and try again.");
      process.exit(0);
    }

    // generate the IR code based on the arch ref
    logger.info("Generating the IaC Code and computing modules...");
    const generateResult = await loadAndGenerate(
      options.generator,
      {
        ...basicArgs,
        language: project.language,
      },
      archRef,
      generatedDir
    );
    infraEntrypoint = path.resolve(generatedDir, generateResult.entrypoint!);
  } else {
    if (!stack.archRefFile || !stack.provisionFile) {
      throw new Error("Please avoid using the --apply option during the initial deployment.");
    }
    archRef = loadArchRef(stack.archRefFile);
    infraEntrypoint = stack.provisionFile;
  }

  return { archRef, infraEntrypoint };
}

export async function deployWithAdapter(adapter: core.Adapter, stack: config.Stack, force = false) {
  logger.info("Applying...");
  const applyResult = await adapter.deploy({ force });
  stack.setDeployed();
  logger.info("Successfully applied!");

  if (applyResult.outputs.length === 0) {
    return;
  }

  const tableData = [["Resource ID", "Output"]];
  for (const key in applyResult.outputs) {
    tableData.push([key, applyResult.outputs[key]]);
  }
  const tableConfig: TableUserConfig = {
    drawHorizontalLine: (lineIndex: number, rowCount: number) => {
      return lineIndex === 0 || lineIndex === 2 || lineIndex === 1 || lineIndex === rowCount;
    },
    header: {
      content: "Deployment Outputs",
    },
    columns: {
      1: {
        wrapWord: true,
      },
    },
  };

  console.log(table(tableData, tableConfig));
}

async function confirmArch(archRef: arch.Architecture, confirmed: boolean): Promise<boolean> {
  // Create the resource table for printing.
  const resData = [
    ["ID", "Name", "Resource Type", "Entity Type"],
    ...archRef.resources.map((resource) => [resource.id, resource.name, resource.type, "Resource"]),
    ...archRef.closures.map((closure) => [closure.id, "-", "-", "Closure"]),
  ];

  // To display the resource table, which includes the resources in the arch ref
  const resConfig: TableUserConfig = {
    drawHorizontalLine: (lineIndex: number, rowCount: number) => {
      return (
        lineIndex === 0 ||
        lineIndex === 2 ||
        lineIndex === 1 ||
        lineIndex === rowCount ||
        lineIndex === archRef.resources.length + 2
      );
    },
    header: {
      content: "Architecture Entities",
    },
  };
  console.log(table(resData, resConfig));

  // Create the relationship table for printing.
  const relatData = [["Source Entity ID", "Target Entity ID", "Relationship Type", "Operation"]];
  for (const relat of archRef.relationships) {
    switch (relat.type) {
      case arch.RelationshipType.Infrastructure: {
        for (const arg of relat.arguments) {
          if (arg.type === "resource") {
            relatData.push([relat.caller.id, arg.resourceId, "Infra", arg.name]);
          } else if (arg.type === "closure") {
            relatData.push([relat.caller.id, arg.closureId, "Infra", arg.name]);
          } else if (arg.type === "capturedProperty") {
            relatData.push([relat.caller.id, arg.resourceId, "Infra", arg.name]);
          }
        }
        break;
      }
      case arch.RelationshipType.Client: {
        relatData.push([relat.bundle.id, relat.resource.id, "Client", relat.operation]);
        break;
      }
      case arch.RelationshipType.CapturedProperty: {
        relatData.push([relat.bundle.id, relat.resource.id, "Property", relat.property]);
        break;
      }
    }
  }

  // To display the relationship table, which includes the relationships among resources in the arch ref.
  const relatConfig: TableUserConfig = {
    drawHorizontalLine: (lineIndex: number, rowCount: number) => {
      return lineIndex === 0 || lineIndex === 2 || lineIndex === 1 || lineIndex === rowCount;
    },
    header: {
      content: "Entity Relationships",
    },
  };
  console.log(table(relatData, relatConfig));

  const result =
    confirmed ||
    (await confirm({
      message: "Does this reference architecture satisfy the design of your application?",
      default: true,
    }));
  return result;
}
