import path from 'path';
import Future from 'fibers/future';
import ScssProcessor from './scss-processor';
import CssModulesProcessor from './css-modules-processor';
import IncludedFile from './included-file';
import pluginOptions from './options';
import plugins from './postcss-plugins';
import getOutputPath from './get-output-path';
const recursive = Npm.require('recursive-readdir');
//import recursive from 'recursive-readdir';

export default class CssModulesBuildPlugin {
	processFilesForTarget(files) {
		files = addFilesFromIncludedFolders(files);
		const allFiles = createAllFilesMap(files);
		const globalVariablesCode = getGlobalVariables(pluginOptions, plugins);

		compileScssFiles.call(this, files);
		compileCssModules.call(this, files);

		function addFilesFromIncludedFolders(files) {
			pluginOptions.explicitIncludes.map(folderPath=> {
				const recursiveFuture = new Future();
				recursive(folderPath, [onlyAllowExtensionsHandledByPlugin], function (err, includedFiles) {
					if (err)
						recursiveFuture.throw(err);
					if (includedFiles)
						files = files.concat(includedFiles.map(filePath=>new IncludedFile(filePath.replace(/\\/g, '/'), files[0])));
					recursiveFuture.return();
				});

				function onlyAllowExtensionsHandledByPlugin(file, stats) {
					let extension = path.extname(file);
					if (extension)
						extension = extension.substring(1);
					return !stats.isDirectory() && pluginOptions.extensions.indexOf(extension) === -1;
				}

				recursiveFuture.wait();
			});
			return files;
		}

		function getGlobalVariables(options, plugins) {
			if (options.extractSimpleVars === false) return;

			const findSimpleVarsPlugin = R.findIndex(plugin=>plugin.postcss && plugin.postcss.postcssPlugin === 'postcss-simple-vars');
			const pluginIndex = findSimpleVarsPlugin(plugins);

			if (pluginIndex === -1) return;
			const variables = plugins[pluginIndex].options.variables;
			const convertJsonVariablesToScssVariables = R.compose(R.reduce((variables, pair)=>variables + `$${pair[0]}: ${pair[1]};\n`, ''), R.toPairs);
			return convertJsonVariablesToScssVariables(variables);
		}

		function compileScssFiles(files) {
			const processor = new ScssProcessor('./', allFiles);
			const isScssRoot = (file)=>isScss(file) && isRoot(file);
			const compileFile = compileScssFile.bind(this);
			files.filter(isScssRoot).forEach(compileFile);
			function isScss(file) {
				const extension = path.extname(file.getPathInPackage()).substring(1);
				return ['scss', 'sass'].indexOf(extension) !== -1;
			}

			function isRoot(inputFile) {
				const fileOptions = inputFile.getFileOptions();
				if (fileOptions.hasOwnProperty('isImport')) {
					return !fileOptions.isImport;
				}
				return !hasUnderscore(inputFile.getPathInPackage());
			}

			function compileScssFile(file) {
				const contents = file.contents = file.getContentsAsString();
				file.contents = `${globalVariablesCode || ''}\n\n${contents || ''}`;

				file.getContentsAsString = function getContentsAsStringWithGlobalVariables() {
					return file.contents;
				};

				const source = {
					path: ImportPathHelpers.getImportPathInPackage(file),
					contents: file.getContentsAsString(),
					file
				};

				let result;
				try {
					result = processor.process(file, source, './', allFiles);
				} catch (err) {
					file.error({
						message: `CSS modules SCSS compiler error: ${JSON.stringify(err, Object.getOwnPropertyNames(err))}\n`,
						sourcePath: file.getDisplayPath()
					});
					return null;
				}

				file.getContentsAsString = function getContentsAsString() {
					return result.source;
				};
			}
		}

		function compileCssModules(files) {
			const processor = new CssModulesProcessor('./');
			const compileFile = processFile.bind(this);
			const isNotScssImport = (file) => !hasUnderscore(file.getPathInPackage());

			files.filter(isNotScssImport).forEach(compileFile);

			function processFile(file) {
				const source = {
					path: ImportPathHelpers.getImportPathInPackage(file),
					contents: file.getContentsAsString()
				};

				return processor.process(source, './', allFiles)
					.then(result => {
						if (result.source)
							file.addStylesheet({
								data: result.source,
								path: getOutputPath(file.getPathInPackage(), pluginOptions.outputCssFilePath) + '.css',
								sourceMap: JSON.stringify(result.sourceMap)
							});

						if (result.tokens)
							file.addJavaScript({
								data: Babel.compile('' +
									`const styles = ${JSON.stringify(result.tokens)};
							 export { styles as default, styles };`).code,
								path: getOutputPath(file.getPathInPackage(), pluginOptions.outputJsFilePath) + '.js',
								sourcePath: getOutputPath(file.getPathInPackage(), pluginOptions.outputJsFilePath) + '.js',
							});
					}).await();
			}
		}

		function hasUnderscore(file) {
			return path.basename(file)[0] === '_';
		}
	}
};


function processFiles(files) {

}

function createAllFilesMap(files) {
	const allFiles = new Map();
	files.forEach((inputFile) => {
		const importPath = ImportPathHelpers.getImportPathInPackage(inputFile);
		allFiles.set(importPath, inputFile);
	});
	return allFiles;
}
