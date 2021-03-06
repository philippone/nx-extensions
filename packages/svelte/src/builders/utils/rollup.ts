import * as rollup from 'rollup';
import { RollupWatcherEvent } from 'rollup';
import { from, Observable } from 'rxjs';
import { map, switchMap } from 'rxjs/operators';
import { BuilderContext, BuilderOutput } from '@angular-devkit/architect';
import { SvelteBuildOptions, RawSvelteBuildOptions } from '../build/schema';
import { DependentBuildableProjectNode } from '@nrwl/workspace/src/utils/buildable-libs-utils';
import { toClassName } from '@nrwl/workspace';
import * as url from 'url';
import { stripIndents } from '@angular-devkit/core/src/utils/literals';
import { convertCopyAssetsToRollupOptions } from './normalize';
import resolve from '@rollup/plugin-node-resolve';

/* eslint-disable */
const typescript = require('@rollup/plugin-typescript');
const sveltePreprocess = require('svelte-preprocess');
const svelte = require('rollup-plugin-svelte')
const copy = require('rollup-plugin-copy');
const serve = require('rollup-plugin-serve');
const livereload = require('rollup-plugin-livereload');
const { terser } = require('rollup-plugin-terser');
const css = require('rollup-plugin-css-only')
const commonjs = require('@rollup/plugin-commonjs');
/* eslint-enable */

export function createRollupOptions(
  options: SvelteBuildOptions,
  dependencies: DependentBuildableProjectNode[],
  context: BuilderContext
): rollup.RollupOptions {
  /* eslint-disable */
  const sveltePreprocessConfig = options.sveltePreprocessConfig
    ? require(options.sveltePreprocessConfig)(options)
    : {};
  /* eslint-enable */

  let plugins = [
    copy({
      targets: convertCopyAssetsToRollupOptions(
        options.assets
      ),
    }),
    typescript({
      tsconfig: options.tsConfig,
      rootDir: options.projectRoot,
      sourceMap: !options.prod,
      inlineSources: !options.prod
    }),
    svelte({
      compilerOptions: {
        dev: !options.prod,
      },
      preprocess: sveltePreprocess(sveltePreprocessConfig),
    }),
    // we'll extract any component CSS out into
    // a separate file - better for performance
    css({ output: 'bundle.css' }),
    resolve({
      browser: true,
      dedupe: ['svelte'],
    }),
    commonjs(),

    options.prod &&
      terser({
        output: {
          comments: false,
        },
      }),
  ];

  if (options.serve) {
    plugins = [
      ...plugins,
      livereload(),
      serve({
        open: options.open,
        verbose: false,
        contentBase: options.outputPath,
        host: options.host,
        port: options.port,
      }),
    ];
  }

  const externalPackages = dependencies
    .map((dependency) => dependency.name)
    .concat(options.external || []);

  const rollupConfig = {
    input: options.entryFile,
    output: {
      format: 'iife',
      file: `${options.outputPath}/bundle.js`,
      name: toClassName(context.target.project),
    },
    external: (id) => externalPackages.includes(id),
    plugins,
  } as rollup.RollupOptions;

  /* eslint-disable */
  return options.rollupConfig
    ? require(options.rollupConfig)(rollupConfig, options)
    : rollupConfig;
  /* eslint-enable */
}

export function runRollup(
  options: rollup.RollupOptions
): Observable<BuilderOutput> {
  return from(rollup.rollup(options)).pipe(
    switchMap((bundle) => {
      const outputOptions: rollup.OutputOptions[] = Array.isArray(
        options.output
      )
        ? options.output
        : [options.output];
      return from(
        Promise.all(outputOptions.map((output) => bundle.write(output)))
      );
    }),
    map(() => ({ success: true }))
  );
}

export function runRollupWatch(
  context: BuilderContext,
  rollupOptions: rollup.RollupOptions,
  svelteBuildOptions: RawSvelteBuildOptions
): Observable<BuilderOutput> {
  return new Observable<BuilderOutput>((obs) => {
    const watcher = rollup.watch(rollupOptions);

    const serverUrl = url.format({
      protocol: 'http',
      hostname: svelteBuildOptions.host,
      port: svelteBuildOptions.port.toString(),
    });

    context.logger.info(stripIndents`
            **
            Web Development Server is listening at ${serverUrl}
            **
          `);

    watcher.on('event', (data: RollupWatcherEvent) => {
      if (data.code === 'START') {
        context.logger.info('Bundling...');
      } else if (data.code === 'END') {
        context.logger.info('Bundle complete. Watching for file changes...');
        obs.next({ success: true });
      } else if (data.code === 'ERROR') {
        context.logger.error(`Error during bundle: ${data.error.message}`);
        obs.next({ success: false });
      }
    });
    // Teardown logic. Close watcher when unsubscribed.
    return () => watcher.close();
  });
}
