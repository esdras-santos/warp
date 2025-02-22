import * as fs from 'fs';
import * as path from 'path';
import assert from 'assert';
import { exec } from 'child_process';
import { expect } from 'chai';
import { hashFilename } from '../src/utils/postCairoWrite';
import { declare } from './testnetInterface';
import { AsyncTest, OUTPUT_DIR } from './behaviour/expectations/types';
import { getPlatform } from '../src/nethersolc';
import { BASE_PATH } from '../src/starknetCli';

interface AsyncTestCluster {
  asyncTest: AsyncTest;
  dependencies: Map<string, string[]>;
}

export async function sh(cmd: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise(function (resolve, reject) {
    exec(cmd, (err, stdout, stderr) => {
      if (err) {
        reject(err);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

const warpBin = path.resolve(__dirname, '..', 'bin', 'warp');
const warpVenvPrefix = `PATH=${path.resolve(__dirname, '..', 'warp_venv', 'bin')}:$PATH`;

export function transpile(contractPath: string): Promise<{ stdout: string; stderr: string }> {
  return sh(`${warpBin} transpile --dev ${contractPath}`);
}

export function gen_interface(
  cairoContractPath: string,
  cairoContractAddress?: string,
): Promise<{ stdout: string; stderr: string }> {
  return sh(
    `${warpBin} gen-interface ${cairoContractPath} --contract-address ${cairoContractAddress}`,
  );
}

export function starknetCompile(
  cairoPath: string,
  jsonOutputPath: string,
): Promise<{ stdout: string; stderr: string }> {
  return sh(
    `${warpVenvPrefix} starknet-compile --cairo_path ${OUTPUT_DIR} ${cairoPath} --output ${jsonOutputPath}`,
  );
}

export function cairoTest(cairoProjectPath: string): Promise<{ stdout: string; stderr: string }> {
  const cairoTestBin = path.resolve(BASE_PATH, 'cairo1', getPlatform(), 'bin', 'cairo-test');
  return sh(`${cairoTestBin} ${cairoProjectPath}`);
}

export function batchPromises<In, Out>(
  inputs: In[],
  parallelCount: number,
  func: (i: In) => Promise<Out>,
): SafePromise<Out>[] {
  const unwrappedPromises: Promise<Out>[] = [];

  for (let i = 0; i < inputs.length; ++i) {
    if (i < parallelCount) {
      unwrappedPromises.push(func(inputs[i]));
    } else {
      unwrappedPromises.push(
        unwrappedPromises[i - parallelCount].then(
          () => func(inputs[i]),
          () => func(inputs[i]),
        ),
      );
    }
  }

  return unwrappedPromises.map(wrapPromise);
}

export type SafePromise<T> = Promise<
  { success: true; result: T } | { success: false; result: unknown }
>;

export function wrapPromise<T>(promise: Promise<T>): SafePromise<T> {
  return promise.then(
    (res) => ({ success: true, result: res }),
    (reason) => ({ success: false, result: { stderr: reason.toString() } }),
  );
}

export function cleanupSync(path: string): void {
  if (fs.existsSync(path)) {
    fs.unlinkSync(path);
  }
}

export function validateInput(input: string): void {
  const num = BigInt(input);
  assert(
    num >= 0n,
    "Negative numbers should not be passed to tests, please convert to two's complement",
  );
}

export function processArgs(
  name: string,
  args: string[],
  deployedAddresses: Map<string, { address: string; hash: string }>,
): string[] {
  return args.flatMap((arg) => {
    if (arg.startsWith('address@')) {
      arg = arg.replace('address@', '');
      const value = deployedAddresses.get(arg);
      if (value === undefined) {
        expect.fail(`${name} failed, cannot find address ${arg}`);
      }
      return BigInt(value.address).toString();
    } else if (arg.startsWith('hash@')) {
      arg = arg.replace('hash@', '');
      const value = deployedAddresses.get(arg);
      if (value === undefined) {
        expect.fail(`${name} failed, cannot find address ${arg}`);
      }
      const low = BigInt(value.hash) % 2n ** 128n;
      const high = BigInt(value.hash) / 2n ** 128n;
      return [low.toString(), high.toString()];
    }
    return arg;
  });
}
export function hashToUint256(hash: string): [string, string] {
  // hash is an array of bytes treated as a string,
  // this converts it to a single bignum with the same bytes
  const bigintHash = [...hash].reduce((acc, c) => (acc << 8n) + BigInt(c.charCodeAt(0)), 0n);

  // We treat class hashes as uint256s due to the lack of a felt type in solidity
  const high = bigintHash / 2n ** 128n;
  const low = bigintHash % 2n ** 128n;
  return [low.toString(10), high.toString(10)];
}

export async function compileCluster(
  test: AsyncTestCluster,
): Promise<{ stdout: string; stderr: string }> {
  const graph = test.dependencies;
  const root = removeOutputDir(test.asyncTest.cairo);
  const dependencies = graph.get(root);
  assert(dependencies !== undefined);

  const declared = new Map<string, string>();
  for (const fileToDeclare of dependencies) {
    const declareHash = await compileDependencyGraph(fileToDeclare, graph, declared);
    const fileLocationHash = hashFilename(fileToDeclare);
    declared.set(fileLocationHash, declareHash);
  }
  return starknetCompile(path.join(OUTPUT_DIR, root), test.asyncTest.compiled);
}

// This is recursively compiling and declaring the needed files for the test.
async function compileDependencyGraph(
  root: string,
  graph: Map<string, string[]>,
  declared: Map<string, string>,
): Promise<string> {
  const declaredHash = declared.get(root);
  if (declaredHash !== undefined) {
    return declaredHash;
  }

  const dependencies = graph.get(root);
  if (dependencies !== undefined) {
    for (const fileToDeclare of dependencies) {
      const declaredHash = await compileDependencyGraph(fileToDeclare, graph, declared);
      const fileLocationHash = hashFilename(fileToDeclare);
      declared.set(fileLocationHash, declaredHash);
    }
  }

  const outputRoot = path.join(OUTPUT_DIR, root);
  const compiledRoot = compileLocation(outputRoot);
  await starknetCompile(outputRoot, compiledRoot);
  const hash = await declare(compiledRoot);
  assert(!hash.threw, `Error during declaration: ${hash.error_message}`);
  return hash.class_hash;
}

function compileLocation(fileLocation: string) {
  return fileLocation.slice(0, -'.cairo'.length).concat('.json');
}

export function removeOutputDir(path: string) {
  assert(path.startsWith(`${OUTPUT_DIR}/`), `Cannot remove output directory from ${path}`);
  return path.slice(`${OUTPUT_DIR}/`.length);
}
