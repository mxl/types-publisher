import * as semver from "semver";
import { Options } from "./lib/common";
import { AllPackages, AnyPackage, TypingsData } from "./lib/packages";
import { npmRegistry } from "./lib/settings";
import { fetchJson} from "./util/io";
import { Logger, logger, writeLog } from "./util/logging";
import { best, done, multiMapAdd, nAtATime } from "./util/util";

if (!module.parent) {
	done(main(true, Options.defaults));
}

export default async function main(includeNpmChecks: boolean, options: Options): Promise<void> {
	const allPackages = await AllPackages.read(options);
	const [log, logResult] = logger();

	checkPathMappings(allPackages);

	const packages = allPackages.allPackages();
	checkForDuplicates(packages, pkg => pkg.libraryName, "Library Name", log);
	checkForDuplicates(packages, pkg => pkg.projectName, "Project Name", log);

	const dependedOn = new Set<string>();
	for (const pkg of packages) {
		if (pkg instanceof TypingsData) {
			for (const dep of pkg.dependencies)
				dependedOn.add(dep.name);
			for (const dep of pkg.testDependencies)
				dependedOn.add(dep);
		}
	}

	if (includeNpmChecks) {
		await nAtATime(10, allPackages.allTypings(), pkg => checkNpm(pkg, log, dependedOn)/*, {
			name: "Checking for typed packages...",
			flavor: pkg => pkg.desc,
			options
		}*/);
	}

	await writeLog("conflicts.md", logResult());
}

function checkForDuplicates(packages: AnyPackage[], func: (info: AnyPackage) => string | undefined, key: string, log: Logger): void {
	const lookup = new Map<string, TypingsData[]>();
	for (const info of packages) {
		const libraryOrProjectName = func(info);
		if (libraryOrProjectName !== undefined) {
			multiMapAdd(lookup, libraryOrProjectName, info);
		}
	}

	for (const [libName, values] of lookup) {
		if (values.length > 1) {
			log(` * Duplicate ${key} descriptions "${libName}"`);
			for (const n of values) {
				log(`   * ${n.desc}`);
			}
		}
	}
}

function checkPathMappings(allPackages: AllPackages) {
	for (const pkg of allPackages.allTypings()) {
		const pathMappings = new Map(pkg.pathMappings);
		const unusedPathMappings = new Set(pathMappings.keys());

		// If A depends on B, and B has path mappings, A must have the same mappings.
		for (const dependency of allPackages.allDependencyTypings(pkg)) {
			for (const [name, dependencyMappingVersion] of dependency.pathMappings) {
				if (pathMappings.get(name) !== dependencyMappingVersion) {
					throw new Error(
						`${pkg.desc} depends on ${dependency.desc}, which has a path mapping for ${name} v${dependencyMappingVersion}. ` +
						`${pkg.desc} must have the same path mappings as its dependencies.`);
				}
				unusedPathMappings.delete(name);
			}

			unusedPathMappings.delete(dependency.name);
		}

		for (const unusedPathMapping of unusedPathMappings) {
			throw new Error(`${pkg.desc} has unused path mapping for ${unusedPathMapping}`);
		}
	}
}

async function checkNpm(pkg: TypingsData, log: Logger, dependedOn: Set<string>): Promise<void> {
	const asOfVersion = await firstPackageVersionWithTypes(pkg.name);
	if (asOfVersion) {
		const ourVersion = `${pkg.major}.${pkg.minor}`;
		log(``);
		log(`Typings already defined for ${pkg.name} (${pkg.libraryName}) as of ${asOfVersion} (our version: ${ourVersion})`);
		const contributorUrls = pkg.contributors.map(c => {
			const gh = "https://github.com/";
			if (c.url.startsWith(gh)) {
				return "@" + c.url.slice(gh.length);
			} else {
				return `${c.name} (${c.url})`;
			}
		}).join(", ");
		const { name, libraryName, projectName } = pkg;
		log(`git checkout -b not-needed-${name}`);
		log(`yarn not-needed -- ${name} ${asOfVersion} ${projectName} ${libraryName !== name ? libraryName : ""}`);
		log(`git add --all && git commit -m "${name}: Provides its own types"`);
		log(`git push -u origin not-needed-${name}`);
		log(`This will deprecate \`@types/${name}\` in favor of just \`${name}\`. CC ${contributorUrls}`);
		if (ourVersion >= asOfVersion) {
			log(`WARNING: our version is greater!`);
		}
		if (dependedOn.has(name)) {
			log(`WARNING: other packages depend on this`);
		}
	}
}

export async function packageHasTypes(packageName: string): Promise<boolean> {
	// Someone published a `express-serve-static-core` package based on DefinitelyTyped. It's not a real package.
	return packageName !== "express-serve-static-core" &&
		(await firstPackageVersionWithTypes(packageName)) !== undefined;
}

async function firstPackageVersionWithTypes(packageName: string): Promise<string | undefined> {
	const uri = npmRegistry + packageName;
	const info = await fetchJson(uri, { retries: true });
	// Info may be empty if the package is not on NPM
	if (!info.versions) {
		return undefined;
	}

	return firstVersionWithTypes(info.versions);
}

function firstVersionWithTypes(versions: { [version: string]: any }): string | undefined {
	const versionsWithTypings = Object.entries(versions).filter(([_version, info]) => hasTypes(info)).map(([version]) => version);
	return best(versionsWithTypings, semver.lt);
}

function hasTypes(info: any): boolean {
	return "types" in info || "typings" in info;
}
