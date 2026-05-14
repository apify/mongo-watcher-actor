import { runInThisContext } from 'node:vm';

export function evalFunctionOrThrow(funcString: string): (parsedLine: Record<string, unknown>) => Record<string, unknown> {
    let func;

    try {
        func = runInThisContext(`(${funcString})`);
    } catch (err) {
        const e = err as Error;
        throw new Error(`Compilation of filterFunction failed.\n${e.message}\n${e.stack!.slice(e.stack!.indexOf('\n'))}`);
    }

    if (typeof func !== 'function') {
        throw new Error('Input parameter "filterFunction" is not a function!');
    }

    return func as (parsedLine: Record<string, unknown>) => Record<string, unknown>;
}