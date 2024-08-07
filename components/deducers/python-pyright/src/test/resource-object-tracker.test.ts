import { ParseNodeType } from "pyright-internal/dist/parser/parseNodes";
import { ResourceObjectTracker } from "../resource-object-tracker";
import * as TypeConsts from "../type-consts";
import * as TestUtils from "./test-utils";

test("should correctly get the construct node for the API call", () => {
  const code = `
from pluto_client import Router, Queue

router = Router("router")
queue = Queue("queue")

# Invoke the resource method on a factory function's return value.
def subscribe_handler(x):
    queue.push("client call")  # client api call
    print(router.url())  # captured property access
queue.subscribe(subscribe_handler)  # infra api call

Queue("queue2").subscribe(subscribe_handler)  # infra api call

aliasQueue = queue
aliasQueue.subscribe(subscribe_handler)  # infra api call
`;

  const { program, sourceFile, clean } = TestUtils.parseCode(code);

  const specialNodeMap = TestUtils.getSpecialNodeMap(program, sourceFile);
  const tracker = new ResourceObjectTracker(program.evaluator!);

  const infraApiCalls = specialNodeMap.getNodesByType(TypeConsts.IRESOURCE_INFRA_API_FULL_NAME);
  infraApiCalls?.forEach((callNode) => {
    const constructNode = tracker.getDeclarationForCallerOfCallNode(callNode);
    expect(constructNode).toBeDefined();
  });

  const clientApiCalls = specialNodeMap.getNodesByType(TypeConsts.IRESOURCE_CLIENT_API_FULL_NAME);
  clientApiCalls?.forEach((callNode) => {
    const constructNode = tracker.getDeclarationForCallerOfCallNode(callNode);
    expect(constructNode).toBeDefined();
  });

  const capturedProps = specialNodeMap.getNodesByType(
    TypeConsts.IRESOURCE_CAPTURED_PROPS_FULL_NAME
  );
  capturedProps?.forEach((callNode) => {
    const constructNode = tracker.getDeclarationForCallerOfCallNode(callNode);
    expect(constructNode).toBeDefined();
  });

  clean();
});

test("should throw an error when the API expression node type is a indirect method call", () => {
  const code = `
from pluto_client.router import Router

router = Router("router")

indirectFn = router.get
indirectFn("/path", lambda x: x)
`;

  const { program, sourceFile, clean } = TestUtils.parseCode(code);
  const specialNodeMap = TestUtils.getSpecialNodeMap(program, sourceFile);
  const tracker = new ResourceObjectTracker(program.evaluator!);

  const infraApiCalls = specialNodeMap.getNodesByType(TypeConsts.IRESOURCE_INFRA_API_FULL_NAME);
  expect(infraApiCalls?.length).toEqual(1);

  const callNode = infraApiCalls![0];

  expect(() => tracker.getDeclarationForCallerOfCallNode(callNode)).toThrow(
    /We currently only support directly calling methods on the resource object/
  );

  clean();
});

test("should throw an error when the variable is assigned to multiple times", () => {
  const code = `
from pluto_client.router import Router

router = 1

router = Router("router")
router.get("/path", lambda x: x)
`;

  const { program, sourceFile, clean } = TestUtils.parseCode(code);
  const specialNodeMap = TestUtils.getSpecialNodeMap(program, sourceFile);
  const tracker = new ResourceObjectTracker(program.evaluator!);

  const infraApiCalls = specialNodeMap.getNodesByType(TypeConsts.IRESOURCE_INFRA_API_FULL_NAME);
  expect(infraApiCalls?.length).toEqual(1);

  const callNode = infraApiCalls![0];

  expect(() => tracker.getDeclarationForCallerOfCallNode(callNode)).toThrow(
    /The resource object has multiple declarations/
  );

  clean();
});

test("should throw an error when the variable is assigned from a function call", () => {
  const code = `
from pluto_client.router import Router

def getRouter():
    return Router("router")

router = getRouter()
router.get("/path", lambda x: x)
`;

  const { program, sourceFile, clean } = TestUtils.parseCode(code);
  const specialNodeMap = TestUtils.getSpecialNodeMap(program, sourceFile);
  const tracker = new ResourceObjectTracker(program.evaluator!);

  const infraApiCalls = specialNodeMap.getNodesByType(TypeConsts.IRESOURCE_INFRA_API_FULL_NAME);
  expect(infraApiCalls?.length).toEqual(1);

  const callNode = infraApiCalls![0];

  expect(() => tracker.getDeclarationForCallerOfCallNode(callNode)).toThrow(
    /We currently only support the variable assigned from a class constructor/
  );

  clean();
});

test("should correctly get the parameter node for the API call invoked within function", () => {
  const code = `
from pluto_client import Queue

def foo(queue: Queue):
  queue.subscribe(lambda x: x)  # infra api call
`;

  const { program, sourceFile, clean } = TestUtils.parseCode(code);

  const specialNodeMap = TestUtils.getSpecialNodeMap(program, sourceFile);
  const tracker = new ResourceObjectTracker(program.evaluator!);

  const infraApiCalls = specialNodeMap.getNodesByType(TypeConsts.IRESOURCE_INFRA_API_FULL_NAME);
  infraApiCalls?.forEach((callNode) => {
    const constructNode = tracker.getDeclarationForCallerOfCallNode(callNode);
    expect(constructNode).toBeDefined();
    expect(constructNode?.nodeType).toBe(ParseNodeType.Parameter);
  });

  clean();
});
