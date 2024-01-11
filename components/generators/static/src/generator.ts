import path from "path";
import fs from "fs";
import * as ts from "typescript";
import * as esbuild from "esbuild";
import { arch, core, utils } from "@plutolang/base";
import { writeToFile } from "./utils";

// The name of the compiled entrypoint
const ENTRYPOINT_FILENAME = "pulumi";
// The name of the compiled compute module for each resource
const COMP_MOD_FILENAME = (resName: string) => `${resName}`;

export class StaticGenerator extends core.Generator {
  //eslint-disable-next-line @typescript-eslint/no-var-requires
  public readonly name = require(path.join(__dirname, "../package.json")).name;
  //eslint-disable-next-line @typescript-eslint/no-var-requires
  public readonly version = require(path.join(__dirname, "../package.json")).version;

  constructor(args: core.BasicArgs) {
    super(args);
  }

  public async generate(archRef: arch.Architecture, outdir: string): Promise<core.GenerateResult> {
    const compiledDir = path.join(outdir, "compiled");

    const pirTsCode = genPirCode(archRef, this.project, this.stack.name);
    writeToFile(outdir, ENTRYPOINT_FILENAME + ".ts", pirTsCode);
    const pirJsCode = compileTs(pirTsCode);
    writeToFile(compiledDir, ENTRYPOINT_FILENAME + ".js", pirJsCode);

    const cirCodes = genAllCirCode(archRef);
    cirCodes.forEach((cir) => {
      const cirTsPath = COMP_MOD_FILENAME(cir.resource.name) + ".ts";
      writeToFile(outdir, cirTsPath, cir.code);
      bundle(path.join(outdir, cirTsPath), compiledDir);
    });

    return { entrypoint: path.join(compiledDir, ENTRYPOINT_FILENAME + ".js") };
  }
}

function bundle(tsPath: string, outdir: string): void {
  const result = esbuild.buildSync({
    bundle: true,
    minify: false,
    entryPoints: [tsPath],
    platform: "node",
    target: "node18",
    outdir: outdir,
  });
  if (result.errors.length > 0) {
    throw new Error("Failed to bundle: " + result.errors[0].text);
  }
}

function compileTs(code: string): string {
  return ts.transpileModule(code, {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText;
}

function genPirCode(archRef: arch.Architecture, projectName: string, stackName: string): string {
  const outputVars = [];
  let iacSource = "";

  // Resource definition, first for BaaS, second for FaaS
  for (const resName in archRef.resources) {
    const res = archRef.getResource(resName);
    if (res.type == "Root" || res.type == "FnResource") continue;

    // TODO: choose the correct package that specified by the user.
    iacSource += `
const ${resName} = await (
  await import("@plutolang/pluto-infra")
).${res.type}.createInstance(${res.getParamString()});\n
`;
  }

  // Specify the dependency of FaaS on this particular BaaS, because the building image process needs to be performed after exporting Dapr YAML.
  for (const resName in archRef.resources) {
    const res = archRef.getResource(resName);
    if (res.type != "FnResource") continue;

    const envVars = [`PLUTO_PROJECT_NAME: "${projectName}"`, `PLUTO_STACK_NAME: "${stackName}"`];
    const deps = [];
    for (const relat of archRef.relationships) {
      if (relat.from != res) continue;
      if (relat.type === arch.RelatType.ACCESS) {
        deps.push(relat.to.name);
      } else if (relat.type === arch.RelatType.PROPERTY) {
        const resourceId = utils.genResourceId(projectName, stackName, relat.to.name);
        const propEnvName = utils.createEnvNameForProperty(
          /* Resource type */ relat.to.type,
          /* Reosurce id */ resourceId,
          /* Property Name */ relat.operation
        );
        const propEnvVal = `${relat.to.name}.${relat.operation}`;
        envVars.push(`${propEnvName}: ${propEnvVal}`);
      }
    }

    // TODO: choose the correct package that specified by the user.
    iacSource += `
const ${resName} = await (
  await import("@plutolang/pluto-infra")
).Function.createInstance(
  ${res.getParamString()}, 
  {
    envs: {${envVars.join(",\n")}}
  }, 
  { 
    dependsOn: [${deps.join(",")}] 
  }
);\n
`;
  }

  // Establish resource dependencies, including triggering and accessing.
  for (const relat of archRef.relationships) {
    if (relat.from.type == "Root") continue;

    if (relat.type == arch.RelatType.CREATE) {
      iacSource += `${relat.from.name}.${relat.operation}(${relat.getParamString()});\n`;
    } else if (relat.type == arch.RelatType.ACCESS) {
      iacSource += `${relat.from.name}.getPermission("${relat.operation}", ${relat.to.name});\n`;
    }
  }

  iacSource += "\n";
  let outputed = false;
  for (const resName in archRef.resources) {
    const res = archRef.getResource(resName);
    if (res.type == "Root") continue;
    iacSource += `${resName}.postProcess();\n`;

    // TODO: update the output mechanism
    if (res.type == "Router" && !outputed) {
      outputed = true;
      outputVars.push(`url: ${res.name}.url`);
    }
    if (res.type == "Tester") {
      iacSource += `const ${res.name}Out = ${res.name}.outputs;\n`;
      outputVars.push(`${res.name}Out`);
    }
  }

  return `
export default (async () => {
${iacSource}

// The return values are the outputs of the resources.
  return {
${outputVars.join(",\n")}
  }
})()
`;
}

interface ComputeIR {
  resource: arch.Resource;
  code: string;
}

interface Segment {
  depth: number;
  start: [number, number];
  end: [number, number];
}

type FileSelection = Map<string, Segment[]>;

function genAllCirCode(archRef: arch.Architecture): ComputeIR[] {
  const rootRes: arch.Resource = archRef.getResource("App");

  const genCirCode = (res: arch.Resource): string => {
    let cirCode = res.getImports().join("\n") + "\n";
    // Append all direct import statments to generated code
    cirCode += rootRes.getImports().join("\n") + "\n";

    // Find the dependencies of this CIR and build corresponding instances.
    for (const relat of archRef.relationships) {
      if (relat.from != res) continue;
      // TODO: verify if the buildClient function exists. If it does not, use the original statement.
      cirCode += relat.to.getImports() + "\n";
      cirCode += `const ${relat.to.name} = ${
        relat.to.type
      }.buildClient(${relat.to.getParamString()});\n`;
    }

    const fileSelections: FileSelection = new Map();
    res.locations.forEach((loc) => {
      if (!fileSelections.has(loc.file)) {
        fileSelections.set(loc.file, []);
      }

      const startPos = loc.linenum["start"].split("-").map((n) => Number(n));
      const endPos = loc.linenum["end"].split("-").map((n) => Number(n));
      fileSelections.get(loc.file)!.push({
        depth: loc.depth,
        start: startPos as [number, number],
        end: endPos as [number, number],
      });
    });
    if (fileSelections.size != 1) {
      throw new Error(`Currently, Pluto only supports a single file.`);
    }

    const fileCodes: [string, string][] = []; // file, code
    fileSelections.forEach((segments, file) => {
      const curFileCode = genFileCode(file, segments);
      fileCodes.push([file, curFileCode]);
    });
    return cirCode + fileCodes[0][1];
  };

  const cirs: ComputeIR[] = [];
  for (const resName in archRef.resources) {
    const res = archRef.getResource(resName);
    if (res.type != "FnResource") continue;
    cirs.push({ resource: res, code: genCirCode(res) });
  }
  return cirs;
}

function genFileCode(file: string, segments: Segment[]): string {
  segments.sort((a, b) => {
    if (a.start[0] != b.start[0]) return a.start[0] - b.start[0];
    return a.start[1] - b.start[1];
  });

  const usercode = fs.readFileSync(file, "utf-8");
  const lines = usercode.split("\n");

  let curFileCode = "";
  for (const segment of segments) {
    const [startLine, startPos] = segment.start;
    const [endLine, endPos] = segment.end;

    let curSegCode = "";
    // Iterate through the range of this segment and construct the code.
    for (let lineIdx = startLine; lineIdx <= endLine; lineIdx++) {
      const linecode = lines[lineIdx];
      let curLineCode = "";
      if (lineIdx == startLine) {
        if (segment.depth == 0) curLineCode = `export default `;
        curLineCode += linecode.slice(startPos);
      } else if (lineIdx == endLine) {
        curLineCode = linecode.slice(0, endPos);
      } else {
        curLineCode = linecode;
      }
      curSegCode += curLineCode + "\n";
    }
    curFileCode += curSegCode + "\n";
  }
  return curFileCode;
}
