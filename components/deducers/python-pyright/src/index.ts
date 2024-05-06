import * as path from "path";
import * as fs from "fs-extra";
import { Uri } from "pyright-internal/dist/common/uri/uri";
import { LogLevel } from "pyright-internal/dist/common/console";
import { Program } from "pyright-internal/dist/analyzer/program";
import { SourceFile } from "pyright-internal/dist/analyzer/sourceFile";
import { DeclarationType } from "pyright-internal/dist/analyzer/declaration";
import { ClassType, TypeCategory } from "pyright-internal/dist/analyzer/types";
import { TypeEvaluator } from "pyright-internal/dist/analyzer/typeEvaluatorTypes";
import {
  ArgumentNode,
  CallNode,
  FunctionNode,
  ParseNodeType,
} from "pyright-internal/dist/parser/parseNodes";
import { core, arch } from "@plutolang/base";
import { genResourceId } from "@plutolang/base/utils";
import * as TypeUtils from "./type-utils";
import * as TypeConsts from "./type-consts";
import * as ProgramUtils from "./program-utils";
import * as ScopeUtils from "./scope-utils";
import { TypeSearcher } from "./type-searcher";
import { SpecialNodeMap } from "./special-node-map";
import { Value, ValueEvaluator } from "./value-evaluator";
import { ResourceObjectTracker } from "./resource-object-tracker";
import { CodeSegment, CodeExtractor } from "./code-extractor";
import { ImportFinder } from "./import-finder";
import { bundleModules } from "./module-bundler";
import packageJson from "../package.json";
import { getDefaultPythonRuntime } from "./module-bundler/command-utils";

export default class PyrightDeducer extends core.Deducer {
  //eslint-disable-next-line @typescript-eslint/no-var-requires
  public readonly name = packageJson.name;
  //eslint-disable-next-line @typescript-eslint/no-var-requires
  public readonly version = packageJson.version;

  private readonly closureDir: string;

  private typeEvaluator?: TypeEvaluator;
  private sepcialNodeMap?: SpecialNodeMap<CallNode>;
  private tracker?: ResourceObjectTracker;
  private valueEvaluator?: ValueEvaluator;
  private extractor?: CodeExtractor;
  private importFinder?: ImportFinder;

  private readonly nodeToResourceMap: Map<number, arch.Resource> = new Map();
  private readonly closures: arch.Closure[] = [];
  private readonly closureToSgementMap: Map<string, CodeSegment> = new Map();
  private readonly relationships: arch.Relationship[] = [];

  constructor(args: core.NewDeducerArgs) {
    super(args);
    this.closureDir = args.closureDir;
  }

  public async deduce(entrypoints: string[]): Promise<core.DeduceResult> {
    entrypoints.forEach((entrypoint, idx) => {
      if (!path.isAbsolute(entrypoint)) {
        entrypoints[idx] = path.resolve(this.rootpath, entrypoint);
      }
    });
    this.valideArgumentsWithThrow(entrypoints);

    const { program, sourceFile } = this.pyrightAnalyze(entrypoints);
    this.typeEvaluator = program.evaluator;
    if (!this.typeEvaluator) {
      throw new Error("No type evaluator found.");
    }

    // Find the special nodes in the source file, including:
    // 1. the resource object construction nodes;
    // 2. the infrastructure API call nodes.
    // 3. the client API call nodes.
    // 4. the nodes that access the captured properties.
    this.sepcialNodeMap = this.getSecpialNodes(program, sourceFile);

    // Check if the resource object construction and infrastructure API calls are in global scope.
    // We only support the resource object construction and infrastructure API calls in global scope
    // currently.
    //
    // TODO: support the resource object construction and infrastructure API calls in non-global
    // scope.
    const constructNodes = this.sepcialNodeMap.getNodesByType(TypeConsts.IRESOURCE_FULL_NAME);
    if (!constructNodes) {
      throw new Error("No resource object construction found.");
    }
    // It's okay to have no infrastructure API calls. Some users might just want to create cloud
    // resources.
    const infraApiNodes =
      this.sepcialNodeMap.getNodesByType(TypeConsts.IRESOURCE_INFRA_API_FULL_NAME) ?? [];
    for (const node of [constructNodes, infraApiNodes].flat()) {
      if (node && !ScopeUtils.inGlobalScope(node, sourceFile)) {
        throw new Error(
          "All constructor and infrastructre API calls related to pluto resource types should be in global scope. We will relax this restriction in the future."
        );
      }
    }

    this.tracker = new ResourceObjectTracker(this.typeEvaluator, this.sepcialNodeMap);
    this.valueEvaluator = new ValueEvaluator(this.typeEvaluator);
    this.extractor = new CodeExtractor(this.typeEvaluator, this.sepcialNodeMap);

    this.buildConstructedResources(constructNodes, sourceFile);
    this.buildRelationshipsFromInfraApis(infraApiNodes, sourceFile);
    this.buildRelationshipsFromClosures(this.closures, sourceFile);

    const execEnv = program.importResolver
      .getConfigOptions()
      .findExecEnvironment(Uri.file(entrypoints[0]))!;
    this.importFinder = new ImportFinder(program.importResolver, execEnv, this.stack.platformType);
    await this.prepareDependencies(this.closures);

    program.dispose();

    const archRef = new arch.Architecture();
    this.nodeToResourceMap.forEach((value) => archRef.addResource(value));
    this.closures.forEach((value) => archRef.addClosure(value));
    this.relationships.forEach((value) => archRef.addRelationship(value));
    return { archRef };
  }

  /**
   * Use the TypeSearcher to get the special nodes in the source file.
   */
  private getSecpialNodes(program: Program, sourceFile: SourceFile) {
    const parseResult = sourceFile.getParseResults();
    if (!parseResult) {
      throw new Error(`No parse result found in source file '${sourceFile.getUri().key}'.`);
    }
    const parseTree = parseResult.parseTree;

    const walker = new TypeSearcher(program.evaluator!, sourceFile);
    walker.walk(parseTree);
    return walker.specialNodeMap;
  }

  private valideArgumentsWithThrow(entrypoints: string[]) {
    if (entrypoints.length === 0) {
      throw new Error("No entrypoints provided.");
    }
    if (entrypoints.length > 1) {
      throw new Error("Only one entrypoint is supported, currently.");
    }
    // Check if all the entrypoint files exist.
    for (const filepath of entrypoints) {
      if (!fs.existsSync(filepath)) {
        throw new Error(`File not found: ${filepath}`);
      }
    }
  }

  /**
   * Utilize the Pyright API to complete the basic analysis.
   */
  private pyrightAnalyze(entrypoints: string[]) {
    const program = ProgramUtils.createProgram({
      logLevel: LogLevel.Warn,
    });

    const fileUris = entrypoints.map((name) => Uri.file(name));
    program.setTrackedFiles(fileUris);
    // Wait for the analysis to complete
    // eslint-disable-next-line no-empty
    while (program.analyze()) {}

    const sourceFile = program.getSourceFile(fileUris[0]);
    if (!sourceFile) {
      throw new Error(`No source file found for '${fileUris[0].key}'.`);
    }

    return { program, sourceFile };
  }

  private buildConstructedResources(constructNodes: CallNode[], sourceFile: SourceFile) {
    for (const node of constructNodes) {
      // Get the parameters of the resource object construction.
      const parameters: arch.Parameter[] = [];

      // First, handle the non-functional arguments to obtain the resource name prior to the closure
      // extraction.
      node.arguments.forEach((argNode, idx) => {
        if (
          TypeUtils.isLambdaNode(argNode.valueExpression) ||
          TypeUtils.isFunctionVar(argNode.valueExpression, this.typeEvaluator!)
        ) {
          // Skip the lambda and function arguments.
          return;
        }

        const parameterName =
          argNode.name?.value ??
          getParameterName(node, idx, this.typeEvaluator!, /* isClassMember */ true) ??
          "unknown";

        // This argument should be composed of literals, and we can convert it into a JSON string.
        const value = this.valueEvaluator!.getValue(argNode.valueExpression);
        parameters.push({
          index: idx,
          name: parameterName,
          type: "text",
          value: Value.toJson(value),
        });
      });

      // Get the name of the resource object. The determination of the resource object name is based
      // on the following rules:
      // 1. If there is a parameter named "name", use its value as the name of the resource object.
      // 2. Otherwise, use "default" as the name of the resource object.
      const nameParam = parameters.find((p) => p.name === "name");
      const resourceName = (JSON.parse(nameParam?.value ?? '""') as string) || "default";

      // Subsequently, process the functional arguments to extract closures and formulate the
      // closure's name, which should be a combination of the resource name, parameter index, and
      // parameter name.
      node.arguments.forEach((argNode, argIdx) => {
        if (
          !TypeUtils.isLambdaNode(argNode.valueExpression) &&
          !TypeUtils.isFunctionVar(argNode.valueExpression, this.typeEvaluator!)
        ) {
          // Skip the non-functional arguments.
          return;
        }

        const parameterName =
          argNode.name?.value ??
          getParameterName(node, argIdx, this.typeEvaluator!, /* isClassMember */ true) ??
          "unknown";

        // This argument is a function or lambda expression, we need to extract it to a closure
        // and store it to a sperate directory.
        const closureId = `${resourceName}_${argIdx}_${parameterName}`;
        const { closure, codeSegment } = extractAndStoreClosure(
          argNode,
          sourceFile,
          closureId,
          this.closureDir,
          this.extractor!
        );
        this.closures.push(closure);
        this.closureToSgementMap.set(closure.id, codeSegment);

        parameters.push({
          index: argIdx,
          name: parameterName,
          type: "closure",
          value: closure.id,
        });
      });

      // Get the full qualified name of the class type.
      const classType = this.typeEvaluator!.getType(node);
      if (!classType || classType.category !== TypeCategory.Class) {
        throw new Error("The constructor node must be a class type.");
      }
      const typeFqn = getFqnOfResourceType(classType, this.valueEvaluator!);

      // Generate the resource id.
      const resourceId = genResourceId(this.project, this.stack.name, typeFqn, resourceName);

      const resource = new arch.Resource(resourceId, resourceName, typeFqn, parameters);
      this.nodeToResourceMap.set(node.id, resource);
    }
  }

  /**
   * For infrastructure API calls, we aim to establish connections between the resource object the
   * caller corresponds to and the resource object or closure the callee corresponds to. We also
   * extract parameters and the operation name.
   */
  private buildRelationshipsFromInfraApis(infraCalls: CallNode[], sourceFile: SourceFile) {
    for (let nodeIdx = 0; nodeIdx < infraCalls.length; nodeIdx++) {
      const node = infraCalls[nodeIdx];

      // Get the resource object associated with the caller.
      const constructNode = this.tracker!.getConstructNodeForApiCall(node, sourceFile);
      if (!constructNode) {
        throw new Error("No resource object found for the infrastructure API call.");
      }
      const fromResource = this.nodeToResourceMap.get(constructNode.id)!;
      const fromResourceId: arch.IdWithType = { id: fromResource.id, type: "resource" };

      // Get the operation name
      const operation = getMemberName(node, this.typeEvaluator!);

      // Get the resource object or closures associated with the callee.
      const toResourceIds: arch.IdWithType[] = [];
      const parameters: arch.Parameter[] = [];
      node.arguments.forEach((argNode, idx) => {
        const parameterName =
          argNode.name?.value ??
          getParameterName(node, idx, this.typeEvaluator!, /* isClassMember */ true) ??
          "unknown";

        if (
          TypeUtils.isLambdaNode(argNode.valueExpression) ||
          TypeUtils.isFunctionVar(argNode.valueExpression, this.typeEvaluator!)
        ) {
          // This argument is a function or lambda expression, we need to extract it to a closure
          // and store it to a sperate directory.
          const closureId = `${fromResource.name}_${nodeIdx}_${operation}_${idx}_${parameterName}`;
          const { closure, codeSegment } = extractAndStoreClosure(
            argNode,
            sourceFile,
            closureId,
            this.closureDir,
            this.extractor!
          );
          this.closures.push(closure);
          this.closureToSgementMap.set(closure.id, codeSegment);
          toResourceIds.push({ id: closure.id, type: "closure" });

          parameters.push({
            index: idx,
            name: parameterName,
            type: "closure",
            value: closure.id,
          });
        } else {
          // Otherwise, this argument should be composed of literals, and we can convert it into a
          // JSON string.
          const value = this.valueEvaluator!.getValue(argNode.valueExpression);
          parameters.push({
            index: idx,
            name: parameterName,
            type: "text",
            value: Value.toJson(value),
          });
        }
      });

      const relationship = new arch.Relationship(
        fromResourceId,
        toResourceIds,
        arch.RelatType.Create,
        operation,
        parameters
      );
      this.relationships.push(relationship);
    }
  }

  /**
   * For each closure, we try to find the client API calls and the accessed captured properties
   * within it. Then we establish the relationships between the closure and the resource objects or
   * closures the client API calls and the accessed captured properties correspond to.
   */
  private buildRelationshipsFromClosures(closures: arch.Closure[], sourceFile: SourceFile) {
    for (const closure of closures) {
      const fromResourceId: arch.IdWithType = { id: closure.id, type: "closure" };

      const codeSegment = this.closureToSgementMap.get(closure.id);
      if (!codeSegment) {
        throw new Error(`No code segment found for closure '${closure.id}'.`);
      }

      // Get the client's API calls and establish the connection between the closure and the
      // resource object associated with the caller.
      CodeSegment.getCalledClientApis(codeSegment).forEach((clientApi) => {
        const constructNode = this.tracker!.getConstructNodeForApiCall(clientApi, sourceFile);
        if (!constructNode) {
          throw new Error("No resource object found for the client API call.");
        }
        const toResource = this.nodeToResourceMap.get(constructNode.id);
        const toResourceId: arch.IdWithType = { id: toResource!.id, type: "resource" };

        const operation = getMemberName(clientApi, this.typeEvaluator!);
        const relationship = new arch.Relationship(
          fromResourceId,
          [toResourceId],
          arch.RelatType.MethodCall,
          operation
        );
        this.relationships.push(relationship);
      });

      // Get the accessed captured properties and establish the connection between the closure and
      // the resource object associated with the accessed captured properties.
      CodeSegment.getAccessedCapturedProperties(codeSegment).forEach((accessedProp) => {
        const constructNode = this.tracker!.getConstructNodeForApiCall(accessedProp, sourceFile);
        if (!constructNode) {
          throw new Error("No resource object found for the client API call.");
        }
        const toResource = this.nodeToResourceMap.get(constructNode.id);
        const toResourceId: arch.IdWithType = { id: toResource!.id, type: "resource" };

        const operation = getMemberName(accessedProp, this.typeEvaluator!);
        const relationship = new arch.Relationship(
          fromResourceId,
          [toResourceId],
          arch.RelatType.PropertyAccess,
          operation
        );
        this.relationships.push(relationship);
      });
    }
  }

  private async prepareDependencies(closures: arch.Closure[]) {
    console.log(`Bundling dependencies, this may take a while...`);
    for (const closure of closures) {
      const destBaseDir = path.resolve(closure.path, "site-packages");

      const closureFile = path.resolve(closure.path, "__init__.py");
      const modules = this.importFinder!.getImportedModulesForSingleFile(closureFile);

      // TODO: Make the Python version and architecture configurable. These values will be used in
      // multiple places, including the Deducer and the infrastructure SDK. The former determines
      // the Python version and architecture for bundling dependencies, while the latter sets the
      // cloud runtime environment.
      const runtime = getDefaultPythonRuntime();
      await bundleModules(runtime, "x86_64", modules, destBaseDir, {
        slim: true,
        // By default, we'll delete the `dist-info` directory, but LangChain needs it, so we'll just
        // delete the `.pyc` and `__pycache__` files.
        uselessFilesPatterns: ["**/*.pyc", "**/__pycache__"],
        cache: true,
        platform: this.stack.platformType,
      });
    }
  }
}

/**
 * Get the name of the parameter at index `idx` for the function associated with this call node.
 * @param callNode - The call node.
 * @param idx - The expected parameter's index.
 * @returns The name of the parameter if it exists; otherwise, undefined.
 */
function getParameterName(
  callNode: CallNode,
  idx: number,
  typeEvaluator: TypeEvaluator,
  isClassMember = false
): string | undefined {
  let functionNode: FunctionNode;

  const type = typeEvaluator!.getType(callNode.leftExpression);
  switch (type?.category) {
    case TypeCategory.Class: {
      const constructor = type.details.fields.get("__init__")?.getDeclarations()[0].node;
      if (constructor?.nodeType !== ParseNodeType.Function) {
        throw new Error(`The __init__ function must be a function.`);
      }
      functionNode = constructor;
      isClassMember = true;
      break;
    }
    case TypeCategory.Function: {
      const func = type.details.declaration?.node;
      if (func?.nodeType !== ParseNodeType.Function) {
        throw new Error(`Only can get the parameter name from a function.`);
      }
      functionNode = func;
      break;
    }
    default:
      throw new Error(`The type of the call node is not supported.`);
  }

  const parameters = functionNode.parameters;
  const realIdx = idx + (isClassMember ? 1 : 0);
  if (realIdx < parameters.length) {
    return parameters[realIdx].name?.value;
  }
  return;
}

function extractAndStoreClosure(
  argNode: ArgumentNode,
  sourceFile: SourceFile,
  closureId: string,
  closureBaseDir: string,
  extractor: CodeExtractor
) {
  const codeSegment = extractor!.extractExpressionRecursively(argNode.valueExpression, sourceFile);
  const closureText = CodeSegment.toString(codeSegment, /* exportName */ "_default");
  const closureFile = path.resolve(closureBaseDir, closureId, "__init__.py");
  fs.ensureFileSync(closureFile);
  fs.writeFileSync(closureFile, closureText);

  return {
    closure: new arch.Closure(closureId, path.dirname(closureFile)),
    codeSegment,
  };
}

function getMemberName(node: CallNode, typeEvaluator: TypeEvaluator) {
  const type = typeEvaluator!.getType(node.leftExpression);
  if (!type || type.category !== TypeCategory.Function) {
    throw new Error("The left expression of the call must be a function.");
  }
  return type.details.name;
}

function getFqnOfResourceType(type: ClassType, valueEvaluator: ValueEvaluator) {
  const fqnMember = type.details.fields.get("fqn");
  if (fqnMember === undefined) {
    throw new Error(`The resource type ${type.details.name} does not have a 'fqn' field.`);
  }

  if (fqnMember.getDeclarations().length !== 1) {
    throw new Error(
      `The 'fqn' field of the resource type ${type.details.name} must be assigned only once.`
    );
  }

  const decl = fqnMember.getDeclarations()[0];
  if (decl.type !== DeclarationType.Variable) {
    throw new Error(
      `The 'fqn' field of the resource type ${type.details.name} must be a variable.`
    );
  }

  const assignmentNode = decl.node.parent;
  if (!assignmentNode || assignmentNode.nodeType !== ParseNodeType.Assignment) {
    throw new Error(
      `The 'fqn' field of the resource type ${type.details.name} must be a variable assignment.`
    );
  }

  const value = valueEvaluator.getValue(assignmentNode.rightExpression);
  const stringifiedFqn = Value.toString(value);
  return JSON.parse(stringifiedFqn);
}
