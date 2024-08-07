import assert from "node:assert";
import { SourceFile } from "pyright-internal/dist/analyzer/sourceFile";
import { TypeEvaluator } from "pyright-internal/dist/analyzer/typeEvaluatorTypes";
import {
  ArgumentNode,
  BinaryOperationNode,
  CallNode,
  ClassNode,
  DictionaryNode,
  ExpressionNode,
  FormatStringNode,
  FunctionNode,
  ImportAsNode,
  ImportFromAsNode,
  IndexNode,
  LambdaNode,
  ListComprehensionForIfNode,
  ListComprehensionNode,
  ListNode,
  MemberAccessNode,
  NameNode,
  ParseNode,
  ParseNodeType,
  StringListNode,
  TupleNode,
  isExpressionNode,
} from "pyright-internal/dist/parser/parseNodes";
import { SymbolTable } from "pyright-internal/dist/analyzer/symbol";
import { TypeCategory } from "pyright-internal/dist/analyzer/types";
import { Scope, ScopeType } from "pyright-internal/dist/analyzer/scope";
import { DeclarationType } from "pyright-internal/dist/analyzer/declaration";
import * as PyrightTypeUtils from "pyright-internal/dist/analyzer/typeUtils";
import { ParseTreeWalker, getChildNodes } from "pyright-internal/dist/analyzer/parseTreeWalker";
import * as AnalyzerNodeInfo from "pyright-internal/dist/analyzer/analyzerNodeInfo";
import { getBuiltInScope, getScopeForNode } from "pyright-internal/dist/analyzer/scopeUtils";
import * as TextUtils from "./text-utils";
import * as TypeUtils from "./type-utils";
import * as TypeConsts from "./type-consts";
import * as ScopeUtils from "./scope-utils";
import { SpecialNodeMap } from "./special-node-map";
import { ValueEvaluator, ValueType, createValueEvaluator } from "./value-evaluator";

export interface CodeSegment {
  readonly node: ParseNode;
  /**
   * If a code segment hasn't an exportable name, it means the segment is not a direct exportable
   * expression, such as a lambda function or a function call. If we want to export the code
   * segment, we need to assign it to a variable, and then export the variable.
   */
  readonly exportableName?: string;
  /**
   * The code after being transformed from a node expression, including constant folding, etc. It
   * contains only one code segment related to the `node`, such as a variable assignment, a function
   * call, a class definition, etc. And it dependencies are specified in the `dependencies`.
   */
  readonly code: string;
  /**
   * The `dependentDeclarations` includes the variables, functions, classes, etc., that are accessed
   * in the current node.
   */
  readonly dependentDeclarations?: CodeSegment[];
  /**
   * The client API calls that are used in the current node.
   */
  readonly calledClientApis?: CallNode[];
  /**
   * The captured properties that are accessed in the current node.
   */
  readonly accessedCapturedProps?: CallNode[];
  /**
   * The environment variables that are accessed in the current node.
   */
  readonly accessedEnvVars?: string[];
}

// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace CodeSegment {
  export function toString(segment: CodeSegment, exportName?: string): string {
    const extractedNodeIds: Set<number> = new Set();
    function concatCodeRecursively(curSegment: CodeSegment): string {
      const depsCode =
        curSegment.dependentDeclarations?.map((dep) => concatCodeRecursively(dep)).join("\n") ?? "";

      if (extractedNodeIds.has(curSegment.node.id)) {
        // Avoid extracting the same node multiple times.
        return depsCode;
      }
      extractedNodeIds.add(curSegment.node.id);

      // The name node is used as a right value, argument, a member access, etc, we don't need to
      // extract it.
      let currentStatement = curSegment.node.nodeType === ParseNodeType.Name ? "" : curSegment.code;
      if (curSegment === segment && exportName) {
        // If the segment is the root segment, and the caller has given an export name, we should
        // assign the segment to the export name.
        if (curSegment.exportableName) {
          // The corresponding node of this segment has a name, such as function or class node. So,
          // we should assign the name to the export name.
          currentStatement += `\n${exportName} = ${curSegment.exportableName}`;
        } else {
          // This segment is a lambda function, a function call, etc. We should assign itself to
          // the export name.
          currentStatement = `${exportName} = ${currentStatement}`;
        }
      }
      return `${depsCode}\n${currentStatement}`;
    }

    return concatCodeRecursively(segment);
  }

  export function getCalledClientApis(segment: CodeSegment): CallNode[] {
    const clientApiCalls: Set<CallNode> = new Set();
    function getCalledClientApisRecursively(segment: CodeSegment) {
      if (segment.calledClientApis) {
        segment.calledClientApis.forEach((callNode) => clientApiCalls.add(callNode));
      }
      segment.dependentDeclarations?.forEach(getCalledClientApisRecursively);
    }
    getCalledClientApisRecursively(segment);
    return Array.from(clientApiCalls);
  }

  export function getAccessedCapturedProperties(segment: CodeSegment): CallNode[] {
    const capturedProperties: Set<CallNode> = new Set();
    function getAccessedCapturedPropertiesRecursively(segment: CodeSegment) {
      if (segment.accessedCapturedProps) {
        segment.accessedCapturedProps.forEach((callNode) => capturedProperties.add(callNode));
      }
      segment.dependentDeclarations?.forEach(getAccessedCapturedPropertiesRecursively);
    }
    getAccessedCapturedPropertiesRecursively(segment);
    return Array.from(capturedProperties);
  }

  export function getAccessedEnvVars(segment: CodeSegment): string[] {
    const envVars: Set<string> = new Set();
    function getAccessedEnvVarsRecursively(segment: CodeSegment) {
      if (segment.accessedEnvVars) {
        segment.accessedEnvVars.forEach((envVar) => envVars.add(envVar));
      }
      segment.dependentDeclarations?.forEach(getAccessedEnvVarsRecursively);
    }
    getAccessedEnvVarsRecursively(segment);
    return Array.from(envVars);
  }

  /**
   * Construct a code segment for a single node using the code segments from its child expressions.
   * @param parentInfo - The information of the parent node.
   * @param children - The code segments of the child expressions.
   * @returns - The code segment of the parent node.
   */
  export function buildWithChildren(
    parentInfo: CodeSegment,
    children?: CodeSegment[]
  ): CodeSegment {
    const result: CodeSegment = {
      node: parentInfo.node,
      exportableName: parentInfo.exportableName,
      code: parentInfo.code,
      dependentDeclarations: parentInfo.dependentDeclarations ?? [],
      calledClientApis: parentInfo.calledClientApis ?? [],
      accessedCapturedProps: parentInfo.accessedCapturedProps ?? [],
      accessedEnvVars: parentInfo.accessedEnvVars ?? [],
    };

    children?.forEach((child) => {
      result.dependentDeclarations!.push(...(child.dependentDeclarations ?? []));
      result.calledClientApis!.push(...(child.calledClientApis ?? []));
      result.accessedCapturedProps!.push(...(child.accessedCapturedProps ?? []));
      result.accessedEnvVars!.push(...(child.accessedEnvVars ?? []));
    });
    return result;
  }
}

/**
 * Extract the code and its dependent declarations of one expression.
 */
export class CodeExtractor {
  private readonly accessedSpecialNodeFinder: AccessedSpecialNodeFinder;
  private readonly valueEvaluator: ValueEvaluator;

  constructor(
    private readonly typeEvaluator: TypeEvaluator,
    // TODO: Remove the special node map from the code extractor, instead, check if a node is a
    // special node internally.
    private readonly specialNodeMap: SpecialNodeMap<CallNode>
  ) {
    this.accessedSpecialNodeFinder = new AccessedSpecialNodeFinder(specialNodeMap);
    this.valueEvaluator = createValueEvaluator(this.typeEvaluator);
  }

  /**
   * Extract the code and its dependent declarations of one expression, such as a variable, a
   * function call, etc.
   * @param node - The expression node.
   * @param sourceFile - The source file where the expression node is located.
   */
  public extractExpressionRecursively(
    node: ExpressionNode,
    sourceFile: SourceFile,
    fillings?: ReadonlyMap<number, ArgumentNode>
  ): CodeSegment {
    let segment: CodeSegment | undefined;
    switch (node.nodeType) {
      case ParseNodeType.Lambda:
        segment = this.extractLambdaRecursively(node, sourceFile, fillings);
        break;
      case ParseNodeType.Name:
        segment = this.extractNameNodeRecursively(node, sourceFile, fillings);
        break;
      case ParseNodeType.Call:
        segment = this.extractCallRecursively(node, sourceFile, fillings);
        break;
      case ParseNodeType.MemberAccess:
        segment = this.extractMemberAccessRecursively(node, sourceFile, fillings);
        break;
      case ParseNodeType.Number:
      case ParseNodeType.Constant:
        segment = CodeSegment.buildWithChildren({
          node,
          code: TextUtils.getTextOfNode(node, sourceFile)!,
        });
        break;
      case ParseNodeType.StringList:
        segment = this.extractStringListRecursively(node, sourceFile, fillings);
        break;
      case ParseNodeType.BinaryOperation:
        segment = this.extractBinaryOperationRecursively(node, sourceFile, fillings);
        break;
      case ParseNodeType.ListComprehension:
        segment = this.extractListComprehensionRecursively(node, sourceFile, fillings);
        break;
      case ParseNodeType.Dictionary:
        segment = this.extractDictRecursively(node, sourceFile, fillings);
        break;
      case ParseNodeType.Tuple:
      case ParseNodeType.List:
        segment = this.extractTupleOrListRecursively(node, sourceFile, fillings);
        break;
      case ParseNodeType.Index:
        segment = this.extractIndexRecursively(node, sourceFile, fillings);
        break;
      default: {
        const nodeText = TextUtils.getTextOfNode(node, sourceFile);
        throw new Error(`Unsupported node type: ${node.nodeType}, text: \`${nodeText}\``);
      }
    }
    return segment;
  }

  private extractLambdaRecursively(
    lambdaNode: LambdaNode,
    sourceFile: SourceFile,
    fillings?: ReadonlyMap<number, ArgumentNode>
  ): CodeSegment {
    const nodeText = TextUtils.getTextOfNode(lambdaNode, sourceFile);

    const lambdaScope = getScopeForNode(lambdaNode.expression);
    if (!lambdaScope) {
      throw new Error(`No scope found for this lambda function '${nodeText}'.`);
    }

    // Find the symbols that are used in the lambda function but defined outside of it.
    const walker = new OutsideSymbolFinder(
      sourceFile,
      this.typeEvaluator,
      this.valueEvaluator,
      lambdaScope
    );
    walker.walk(lambdaNode);

    // Extract each symbol that is used in the lambda function but defined outside of it. We will
    // append the delarations of these symbols to the lambda function.
    const children: CodeSegment[] = [];
    for (const nameNode of walker.nameNodes) {
      const childSegment = this.extractNameNodeRecursively(nameNode, sourceFile, fillings);
      children.push(childSegment);
    }

    return CodeSegment.buildWithChildren(
      {
        node: lambdaNode,
        code: nodeText!,
        calledClientApis: this.accessedSpecialNodeFinder.findClientApiCalls(lambdaNode),
        accessedCapturedProps: this.accessedSpecialNodeFinder.findCapturedProperties(lambdaNode),
        accessedEnvVars: walker.envVarNames,
      },
      children
    );
  }

  /**
   * The name node can represent various types of nodes, like variables, functions, classes, etc.
   * When dealing with the name node, we extract what it refers to — the declaration — rather than the
   * node itself, and return the code segment for that declaration. Therefore, the function's return
   * value is the code segment of the declaration associated with the name node.
   */
  private extractNameNodeRecursively(
    nameNode: NameNode,
    sourceFile: SourceFile,
    fillings?: ReadonlyMap<number, ArgumentNode>
  ): CodeSegment {
    const lookUpResult = this.typeEvaluator.lookUpSymbolRecursive(nameNode, nameNode.value, false);
    if (!lookUpResult) {
      throw new Error(`No symbol found for node '${nameNode.value}'.`);
    }

    // Find the declaration of the symbol.
    const symbol = lookUpResult.symbol;
    if (!symbol.hasDeclarations()) {
      throw new Error(`No declaration found for symbol '${nameNode.value}'.`);
    }
    const declarations = symbol.getDeclarations();
    if (declarations.length > 1) {
      throw new Error(
        `Multiple declarations found for symbol '${nameNode.value}'. We don't support this yet.`
      );
    }
    const declaration = declarations[0];

    let declSegment: CodeSegment;
    switch (declaration.type) {
      case DeclarationType.Variable: {
        switch (declaration.node.nodeType) {
          case ParseNodeType.StringList: {
            declSegment = CodeSegment.buildWithChildren({
              node: declaration.node,
              code: TextUtils.getTextOfNode(declaration.node, sourceFile)!,
            });
            break;
          }
          case ParseNodeType.Name: {
            // The name node is a variable.
            declSegment = this.extractVariableRecursively(declaration.node, sourceFile, fillings);
            break;
          }
          default:
            throw new Error(`Unable to reach here.`);
        }
        break;
      }

      case DeclarationType.Parameter: {
        // This could happen when try to extract for a bundle created witin a custom infrastucture
        // function.
        const argumentNode = fillings?.get(declaration.node.id);
        if (argumentNode === undefined) {
          throw new Error(`No argument found for parameter '${nameNode.value}'.`);
        }

        // When a name node is linked to an parameter node, and we can't locate a corresponding
        // assignment node for it, the solution is to directly extract the argument node. Then we
        // use this to take up the spot originally held by the name node.
        return this.extractExpressionRecursively(
          argumentNode.valueExpression,
          sourceFile,
          fillings
        );
      }

      case DeclarationType.Function: {
        declSegment = this.extractFunctionRecursively(declaration.node, sourceFile, fillings);
        break;
      }

      case DeclarationType.Class: {
        declSegment = this.extractClassRecursively(declaration.node, sourceFile, fillings);
        break;
      }

      case DeclarationType.Alias: {
        switch (declaration.node.nodeType) {
          case ParseNodeType.ImportFromAs:
            declSegment = this.extractImportFromAs(declaration.node);
            break;
          case ParseNodeType.ImportAs:
            declSegment = this.extractImportAs(declaration.node);
            break;
          default:
            throw new Error(`Unsupported node type: ${declaration.node.nodeType}`);
        }
        break;
      }

      case DeclarationType.Intrinsic: {
        // The intrinsic declaration is a module, a function, or a class that is built-in. We don't
        // need to extract it.
        declSegment = CodeSegment.buildWithChildren({
          node: declaration.node,
          code: "",
        });
        break;
      }

      default:
        if (process.env.DEBUG) {
          console.debug(
            "Don't support this declaration: ",
            TextUtils.getTextOfNode(declaration.node, sourceFile)
          );
        }
        throw new Error(`Unsupported declaration type: ${declaration.type}`);
    }

    return CodeSegment.buildWithChildren({
      node: nameNode,
      exportableName: nameNode.value,
      code: nameNode.value,
      dependentDeclarations: [declSegment],
    });
  }

  private extractVariableRecursively(
    node: NameNode,
    sourceFile: SourceFile,
    fillings?: ReadonlyMap<number, ArgumentNode>
  ): CodeSegment {
    if (node.parent?.nodeType === ParseNodeType.ListComprehensionFor) {
      // This variable is defined in a list comprehension for loop, we don't need to extract it.
      return CodeSegment.buildWithChildren({
        node: node,
        code: node.value,
      });
    }

    if (node.parent?.nodeType !== ParseNodeType.Assignment) {
      throw new Error(
        `We only support the simplest assignment statement, the tuple assignment or other statements are not supported yet.`
      );
    }

    const rightExpression = node.parent.rightExpression;
    const segment = this.extractExpressionRecursively(rightExpression, sourceFile, fillings);

    // We cannot use the source code of the assignment statement directly, as it may contain the
    // creation of a resource object, which the constructor call might be different from the
    // original code.
    const statement = `${node.value} = ${segment.code}`;
    return CodeSegment.buildWithChildren(
      {
        node: node.parent,
        exportableName: node.value,
        code: statement,
      },
      [segment]
    );
  }

  private extractFunctionRecursively(
    funcNode: FunctionNode,
    sourceFile: SourceFile,
    fillings?: ReadonlyMap<number, ArgumentNode>
  ): CodeSegment {
    const functionScope = getScopeForNode(funcNode.suite);
    if (!functionScope) {
      throw new Error(`No scope found for this function '${funcNode.name.value}'.`);
    }

    const walker = new OutsideSymbolFinder(
      sourceFile,
      this.typeEvaluator,
      this.valueEvaluator,
      functionScope,
      funcNode.name
    );
    walker.walk(funcNode);

    const children: CodeSegment[] = [];
    for (const nameNode of walker.nameNodes) {
      const childSegment = this.extractNameNodeRecursively(nameNode, sourceFile, fillings);
      children.push(childSegment);
    }

    return CodeSegment.buildWithChildren(
      {
        node: funcNode,
        exportableName: funcNode.name.value,
        code: TextUtils.getTextOfNode(funcNode, sourceFile)!,
        calledClientApis: this.accessedSpecialNodeFinder.findClientApiCalls(funcNode),
        accessedCapturedProps: this.accessedSpecialNodeFinder.findCapturedProperties(funcNode),
        accessedEnvVars: walker.envVarNames,
      },
      children
    );
  }

  private extractCallRecursively(
    node: CallNode,
    sourceFile: SourceFile,
    fillings?: ReadonlyMap<number, ArgumentNode>
  ): CodeSegment {
    // If the call node can be found in the special node map, it means the call node is for
    // constructing a resource object.
    const isConstructedNode = !!this.specialNodeMap.getNodeById(
      node.id,
      TypeConsts.IRESOURCE_FULL_NAME
    );

    // Check if the call node is for accessing an environment variable, like `os.environ.get('key')`.
    const isAccessingEnvVar = TypeUtils.isEnvVarAccess(node, this.typeEvaluator);

    const children: CodeSegment[] = [];
    // The code for building each argument of the construct statement.
    const argumentCodes: string[] = [];
    const accessedEnvVars: string[] = [];
    node.arguments.forEach((argNode, ardIdx) => {
      // If the call node is for constructing a resource object, we don't need to extract the
      // function type argument from it. The function type argument will be sent to the cloud and
      // accessed via RPC.
      const extractFunctionArg = !isConstructedNode;
      const segment = this.extractArgumentRecursively(
        argNode,
        sourceFile,
        extractFunctionArg,
        fillings
      );
      children.push(segment);
      argumentCodes.push(segment.code);

      if (isAccessingEnvVar && ardIdx === 0) {
        // If the call node is for accessing an environment variable, we should extract the
        // environment variable key from the argument.
        const envVarName = getEnvVarName(argNode.valueExpression, sourceFile, this.valueEvaluator);
        accessedEnvVars.push(envVarName);
      }
    });

    const methodSegment = this.extractExpressionRecursively(
      node.leftExpression,
      sourceFile,
      fillings
    );
    const methodCode = methodSegment.code;
    children.push(methodSegment);

    const statement = `${methodCode}(${argumentCodes.join(", ")})`;
    return CodeSegment.buildWithChildren(
      {
        node: node,
        code: statement,
        // If the call node is used to build a resource object, we don't have to extract them, as
        // we'll communicate with this resource object through RPC.
        calledClientApis: !isConstructedNode
          ? this.accessedSpecialNodeFinder.findClientApiCalls(node)
          : [],
        accessedCapturedProps: !isConstructedNode
          ? this.accessedSpecialNodeFinder.findCapturedProperties(node)
          : [],
        accessedEnvVars: accessedEnvVars,
      },
      children
    );
  }

  private extractArgumentRecursively(
    arg: ArgumentNode,
    sourceFile: SourceFile,
    extractFunctionArg: boolean,
    fillings?: ReadonlyMap<number, ArgumentNode>
  ): CodeSegment {
    const codePrefix = arg.name ? `${arg.name.value}=` : "";

    if (
      TypeUtils.isLambdaNode(arg.valueExpression) ||
      TypeUtils.isFunctionVar(arg.valueExpression, this.typeEvaluator)
    ) {
      // The argument is either a lambda function, a function variable, or a function call which
      // returns a function.
      if (!extractFunctionArg) {
        // If we don't need to extract the function argument, we just use a lambda function as a
        // placeholder.
        return CodeSegment.buildWithChildren({
          node: arg,
          code: `${codePrefix}lambda _: _`,
        });
      }
    }

    const valueSegment = this.extractExpressionRecursively(
      arg.valueExpression,
      sourceFile,
      fillings
    );
    return CodeSegment.buildWithChildren(
      {
        node: arg,
        code: `${codePrefix}${valueSegment.code}`,
      },
      [valueSegment]
    );
  }

  /**
   * Extract the class definition and its dependent declarations.
   * @param classNode - The class node.
   * @param sourceFile - The source file where the class node is located.
   */
  private extractClassRecursively(
    classNode: ClassNode,
    sourceFile: SourceFile,
    fillings?: ReadonlyMap<number, ArgumentNode>
  ): CodeSegment {
    const nodeText = TextUtils.getTextOfNode(classNode, sourceFile);

    const classScope = getScopeForNode(classNode.suite);
    if (!classScope) {
      throw new Error(`No scope found for this lambda function '${nodeText}'.`);
    }

    // The class node and its members are at the same scope level, which means that the scope of the
    // members does not function as a child scope to that of the class node. Consequently, variables
    // declared within the class members are confined to the scope of those members rather than to
    // the class itself. Determining whether these variables need to be extracted as dependencies by
    // assessing if their scope is encapsulated within the class's scope is not a clear-cut process.
    // Therefore, we get all symbols that represent the class members. Subsequently, for each name
    // node existing within the scope of the class node, we can ignore it if its corresponding
    // symbol denotes a class member or if its scope is encompassed by that of the class members.
    const classType = this.typeEvaluator.getType(classNode.name);
    assert(classType, `No type found for class '${nodeText}'.`);
    assert(
      classType.category === TypeCategory.Class,
      `The type of the class '${nodeText}' is not a class.`
    );
    const members: SymbolTable = new Map();
    PyrightTypeUtils.getMembersForClass(classType, members, /* includeInstanceVars */ false);

    const walker = new OutsideSymbolFinder(
      sourceFile,
      this.typeEvaluator,
      this.valueEvaluator,
      classScope,
      classNode.name,
      members
    );
    walker.walk(classNode);

    const children: CodeSegment[] = [];
    for (const nameNode of walker.nameNodes) {
      const childSegment = this.extractNameNodeRecursively(nameNode, sourceFile, fillings);
      children.push(childSegment);
    }

    return CodeSegment.buildWithChildren(
      {
        node: classNode,
        exportableName: classNode.name.value,
        code: nodeText!,
        calledClientApis: this.accessedSpecialNodeFinder.findClientApiCalls(classNode),
        accessedCapturedProps: this.accessedSpecialNodeFinder.findCapturedProperties(classNode),
        accessedEnvVars: walker.envVarNames,
      },
      children
    );
  }

  /**
   * Extract the member access expression, like `obj.method`, `func().method`, `module.method`, etc.
   * Only the left expression needs to be extracted, as the right expression is the method name,
   * which isn't a dependency.
   * @param node - The member access node.
   * @param sourceFile - The source file where the member access node is located.
   */
  private extractMemberAccessRecursively(
    node: MemberAccessNode,
    sourceFile: SourceFile,
    fillings?: ReadonlyMap<number, ArgumentNode>
  ): CodeSegment {
    const callerSegment = this.extractExpressionRecursively(
      node.leftExpression,
      sourceFile,
      fillings
    );
    const code = `${callerSegment.code}.${node.memberName.value}`;
    return CodeSegment.buildWithChildren(
      {
        node: node,
        code: code,
      },
      [callerSegment]
    );
  }

  private extractStringListRecursively(
    node: StringListNode,
    sourceFile: SourceFile,
    fillings?: ReadonlyMap<number, ArgumentNode>
  ): CodeSegment {
    const children: CodeSegment[] = [];
    node.strings
      .filter((node) => node.nodeType === ParseNodeType.FormatString)
      .forEach((stringNode) => {
        const formatStringNode = stringNode as FormatStringNode;
        formatStringNode.fieldExpressions.forEach((expr) => {
          const segment = this.extractExpressionRecursively(expr, sourceFile, fillings);
          children.push(segment);
        });
      });

    return CodeSegment.buildWithChildren(
      {
        node: node,
        code: TextUtils.getTextOfNode(node, sourceFile)!,
      },
      children
    );
  }

  private extractBinaryOperationRecursively(
    node: BinaryOperationNode,
    sourceFile: SourceFile,
    fillings?: ReadonlyMap<number, ArgumentNode>
  ): CodeSegment {
    const leftSegment = this.extractExpressionRecursively(
      node.leftExpression,
      sourceFile,
      fillings
    );
    const rightSegment = this.extractExpressionRecursively(
      node.rightExpression,
      sourceFile,
      fillings
    );
    return CodeSegment.buildWithChildren(
      {
        node: node,
        code: TextUtils.getTextOfNode(node, sourceFile)!,
      },
      [leftSegment, rightSegment]
    );
  }

  private extractListComprehensionRecursively(
    node: ListComprehensionNode,
    sourceFile: SourceFile,
    fillings?: ReadonlyMap<number, ArgumentNode>
  ): CodeSegment {
    if (!isExpressionNode(node.expression)) {
      throw new Error(`Unsupported node type ${node.expression.nodeType} in list comprehension.`);
    }

    const children: CodeSegment[] = [];

    const segment = this.extractExpressionRecursively(node.expression, sourceFile, fillings);
    children.push(segment);

    node.forIfNodes.forEach((forIfNode: ListComprehensionForIfNode) => {
      switch (forIfNode.nodeType) {
        case ParseNodeType.ListComprehensionFor: {
          const forSegment = this.extractExpressionRecursively(
            forIfNode.iterableExpression,
            sourceFile,
            fillings
          );
          children.push(forSegment);

          const targetSegment = this.extractExpressionRecursively(
            forIfNode.targetExpression,
            sourceFile,
            fillings
          );
          children.push(targetSegment);
          break;
        }
        case ParseNodeType.ListComprehensionIf: {
          const ifSegment = this.extractExpressionRecursively(
            forIfNode.testExpression,
            sourceFile,
            fillings
          );
          children.push(ifSegment);
          break;
        }
        default:
          throw new Error(`Unable to reach here.`);
      }
    });

    return CodeSegment.buildWithChildren(
      {
        node: node,
        code: TextUtils.getTextOfNode(node, sourceFile)!,
      },
      children
    );
  }

  /**
   * Iterate through the dictionary node and extract the dependent declarations of each key-value
   * pair.
   */
  private extractDictRecursively(
    node: DictionaryNode,
    sourceFile: SourceFile,
    fillings?: ReadonlyMap<number, ArgumentNode>
  ): CodeSegment {
    const children: CodeSegment[] = [];
    node.entries.forEach((entry) => {
      if (entry.nodeType !== ParseNodeType.DictionaryKeyEntry) {
        throw new Error(`Unsupported dictionary entry type: ${entry.nodeType}`);
      }

      const keySegment = this.extractExpressionRecursively(
        entry.keyExpression,
        sourceFile,
        fillings
      );
      children.push(keySegment);

      const valueSegment = this.extractExpressionRecursively(
        entry.valueExpression,
        sourceFile,
        fillings
      );
      children.push(valueSegment);
    });

    return CodeSegment.buildWithChildren(
      {
        node: node,
        code: TextUtils.getTextOfNode(node, sourceFile)!, // The text of the dictionary node.
      },
      children
    );
  }

  /**
   * Iterate through the tuple or list node and extract the dependent declarations of each item.
   */
  private extractTupleOrListRecursively(
    node: TupleNode | ListNode,
    sourceFile: SourceFile,
    fillings?: ReadonlyMap<number, ArgumentNode>
  ): CodeSegment {
    const items = node.nodeType === ParseNodeType.Tuple ? node.expressions : node.entries;

    const children: CodeSegment[] = [];
    items.forEach((item) => {
      const segment = this.extractExpressionRecursively(item, sourceFile, fillings);
      children.push(segment);
    });

    return CodeSegment.buildWithChildren(
      {
        node: node,
        code: TextUtils.getTextOfNode(node, sourceFile)!, // The text of the tuple or list node.
      },
      children
    );
  }

  /**
   * Extract the import-from statement, such as `from module import name`, `from module import name
   * as alias`.
   * @param node
   * @returns
   */
  private extractImportFromAs(node: ImportFromAsNode): CodeSegment {
    assert(node.parent?.nodeType === ParseNodeType.ImportFrom);
    const moduleNameNode = node.parent.module;
    const moduleName = AnalyzerNodeInfo.getImportInfo(moduleNameNode)?.importName;
    assert(moduleName);

    const name = node.name.value;
    const alias = node.alias?.value;
    const statement = `from ${moduleName} import ${name}` + (alias ? ` as ${alias}` : "");
    return CodeSegment.buildWithChildren({
      node: node,
      code: statement,
    });
  }

  /**
   * Extract the import statement, such as `import module`, `import module as alias`.
   * @param node - The import-as node.
   */
  private extractImportAs(node: ImportAsNode): CodeSegment {
    const moduleNameNode = node.module;
    const moduleName = AnalyzerNodeInfo.getImportInfo(moduleNameNode)?.importName;
    assert(moduleName);

    const alias = node.alias?.value;
    const statement = `import ${moduleName}` + (alias ? ` as ${alias}` : "");
    return CodeSegment.buildWithChildren({
      node: node,
      code: statement,
    });
  }

  private extractIndexRecursively(
    node: IndexNode,
    sourceFile: SourceFile,
    fillings?: ReadonlyMap<number, ArgumentNode>
  ): CodeSegment {
    const isAccessingEnvVar = TypeUtils.isEnvVarAccess(node, this.typeEvaluator);

    const baseSegment = this.extractExpressionRecursively(
      node.baseExpression,
      sourceFile,
      fillings
    );

    const indexItemSegments: CodeSegment[] = [];
    const accessedEnvVars: string[] = [];
    node.items.forEach((item) => {
      const indexSegment = this.extractExpressionRecursively(
        item.valueExpression,
        sourceFile,
        fillings
      );
      indexItemSegments.push(indexSegment);

      if (isAccessingEnvVar) {
        // If the index node is accessing an environment variable, we should extract the environment
        // variable key from the index item.
        const envVarName = getEnvVarName(item.valueExpression, sourceFile, this.valueEvaluator);
        accessedEnvVars.push(envVarName);
      }
    });

    const code = `${baseSegment.code}[${indexItemSegments.map((seg) => seg.code).join(", ")}]`;
    return CodeSegment.buildWithChildren(
      {
        node: node,
        code: code,
        accessedEnvVars: accessedEnvVars,
      },
      [baseSegment].concat(indexItemSegments)
    );
  }
}

/**
 * Get the symbols that are used in the function but defined outside of it, and not in the built-in
 * scope.
 */
class OutsideSymbolFinder extends ParseTreeWalker {
  private readonly _nameNodes: Map<number, NameNode> = new Map();
  private readonly _envVarNames: Set<string> = new Set();

  constructor(
    private readonly sourceFile: SourceFile,
    private readonly typeEvaluator: TypeEvaluator,
    private readonly valueEvaluator: ValueEvaluator,
    private readonly scope: Scope,
    private readonly rootNode?: ParseNode,
    private readonly members?: SymbolTable // Only used for class members.
  ) {
    super();
  }

  /**
   * The name nodes that defined outside of the function, and not in the built-in scope.
   */
  public get nameNodes(): NameNode[] {
    return Array.from(this._nameNodes.values());
  }

  /**
   * The environment variable names that are accessed in the function.
   */
  public get envVarNames(): string[] {
    return Array.from(this._envVarNames);
  }

  public override visitName(node: NameNode): boolean {
    if (node !== this.rootNode && !this.shouldIgnore(node)) {
      const symbol = this.typeEvaluator.lookUpSymbolRecursive(node, node.value, false);
      assert(symbol); // The symbol cannot be undefined; it's checked in `shouldIgnore`.
      this._nameNodes.set(node.id, node);
    }
    return true;
  }

  public override visitCall(node: CallNode): boolean {
    if (TypeUtils.isEnvVarAccess(node, this.typeEvaluator)) {
      assert(
        node.arguments.length === 1,
        `The function for accessing environment variables should only take one argument.`
      );
      const envVarName = getEnvVarName(
        node.arguments[0].valueExpression,
        this.sourceFile,
        this.valueEvaluator
      );
      this._envVarNames.add(envVarName);
    }
    return true;
  }

  public override visitIndex(node: IndexNode): boolean {
    if (TypeUtils.isEnvVarAccess(node, this.typeEvaluator)) {
      assert(
        node.items.length === 1,
        `The length of the items in 'os.environ["ENV_NAME"]' should be only one.`
      );
      const envVarName = getEnvVarName(
        node.items[0].valueExpression,
        this.sourceFile,
        this.valueEvaluator
      );
      this._envVarNames.add(envVarName);
    }
    return true;
  }

  private shouldIgnore(node: NameNode): boolean {
    const symbolWithScope = this.typeEvaluator.lookUpSymbolRecursive(node, node.value, false);

    if (this.scope.type === ScopeType.Class && this.members) {
      for (const memberSymbol of this.members.values()) {
        if (memberSymbol === symbolWithScope?.symbol) {
          // The symbol is a class member, so we should ignore it.
          return true;
        }

        const memberScope = ScopeUtils.getScopeForSymbol(memberSymbol);
        if (
          symbolWithScope &&
          memberScope &&
          ScopeUtils.isScopeContainedWithin(symbolWithScope.scope, memberScope)
        ) {
          // The symbol is defined in the scope of the class members, so we should ignore it.
          return true;
        }
      }
    }

    if (symbolWithScope && ScopeUtils.isScopeContainedWithin(symbolWithScope.scope, this.scope)) {
      // The symbol is defined in the function's scope.
      return true;
    }

    if (this.scope.lookUpSymbol(node.value)) {
      // Ignore the local variables. We don't need to package the local variables.
      return true;
    }

    if (node.parent?.nodeType === ParseNodeType.MemberAccess && node.parent.memberName === node) {
      // Ignore the member access. We just need to check if the caller is outside of the scope.
      return true;
    }

    if (node.parent?.nodeType === ParseNodeType.Argument && node.parent.name === node) {
      // Ignore the argument name.
      return true;
    }

    if (node.parent?.nodeType === ParseNodeType.Parameter && node.parent.name === node) {
      // Ignore the parameter name.
      return true;
    }

    if (node.value === "self") {
      // Ignore the `self` parameter.
      return true;
    }

    // Check if the symbol linked to this node is from the built-in scope.
    // ```python
    // isinstance(arr, list)
    // name: str = "hello"
    // ```
    const result = this.typeEvaluator.lookUpSymbolRecursive(node, node.value, false);
    if (!result) {
      throw new Error(`No symbol found for node '${node.value}'.`);
    }
    if (result.scope === getBuiltInScope(this.scope)) {
      // This symobl is from the built-in scope.
      return true;
    }
    return false;
  }
}

interface AccessedSpecialNodeIds {
  readonly constructorCalls: readonly number[];
  readonly clientApiCalls: readonly number[];
  readonly capturedProperties: readonly number[];
}

/**
 * Find the special nodes that are accessed in the given parse node.
 */
class AccessedSpecialNodeFinder {
  private readonly accessedSpecialNodesMap: Map<number, AccessedSpecialNodeIds> = new Map();

  constructor(private readonly sepcialNodeMap: SpecialNodeMap<CallNode>) {}

  public findClientApiCalls(node: ParseNode): CallNode[] {
    const accessedSpecialNodes = this.visit(node);
    return accessedSpecialNodes.clientApiCalls.map(
      (id) => this.sepcialNodeMap.getNodeById(id, TypeConsts.IRESOURCE_CLIENT_API_FULL_NAME)!
    );
  }

  public findCapturedProperties(node: ParseNode): CallNode[] {
    const accessedSpecialNodes = this.visit(node);
    return accessedSpecialNodes.capturedProperties.map(
      (id) => this.sepcialNodeMap.getNodeById(id, TypeConsts.IRESOURCE_CAPTURED_PROPS_FULL_NAME)!
    );
  }

  private visit(node: ParseNode): AccessedSpecialNodeIds {
    if (this.accessedSpecialNodesMap.has(node.id)) {
      return this.accessedSpecialNodesMap.get(node.id)!;
    }

    const constructorCalls: number[] = [];
    const clientApiCalls: number[] = [];
    const capturedProperties: number[] = [];

    if (node.nodeType === ParseNodeType.Call) {
      if (this.sepcialNodeMap.getNodeById(node.id, TypeConsts.IRESOURCE_FULL_NAME)) {
        constructorCalls.push(node.id);
      }
      if (this.sepcialNodeMap.getNodeById(node.id, TypeConsts.IRESOURCE_CLIENT_API_FULL_NAME)) {
        clientApiCalls.push(node.id);
      }
      if (this.sepcialNodeMap.getNodeById(node.id, TypeConsts.IRESOURCE_CAPTURED_PROPS_FULL_NAME)) {
        capturedProperties.push(node.id);
      }
    }

    getChildNodes(node).forEach((child) => {
      if (!child) {
        return;
      }

      const childAccessedNodes = this.visit(child);
      constructorCalls.push(...childAccessedNodes.constructorCalls);
      clientApiCalls.push(...childAccessedNodes.clientApiCalls);
      capturedProperties.push(...childAccessedNodes.capturedProperties);
    });

    const accessedSpecialNodes = { constructorCalls, clientApiCalls, capturedProperties };
    this.accessedSpecialNodesMap.set(node.id, accessedSpecialNodes);
    return accessedSpecialNodes;
  }
}

function getEnvVarName(
  node: ExpressionNode,
  sourceFile: SourceFile,
  valueEvaluator: ValueEvaluator
): string {
  const value = valueEvaluator.evaluate(node);
  if (value.valueType !== ValueType.Literal || typeof value.value !== "string") {
    const text = TextUtils.getTextOfNode(node, sourceFile);
    throw new Error(
      `The value of the index item '${text}' is not a string literal ${value}, so we can't retrieve the environment variable key from it.`
    );
  }
  return value.value;
}
