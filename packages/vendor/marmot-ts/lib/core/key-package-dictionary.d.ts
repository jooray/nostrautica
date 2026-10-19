/** @module @category Core - Key Package */
import { type AppDataDictionary, type CustomExtension, type KeyPackage } from "../vendor/ts-mls/index.js";
/** Read a unique, exactly encoded dictionary; validate the reusable marker. */
export declare function readKeyPackageDictionary(extensions: CustomExtension[]): AppDataDictionary | undefined;
/** Classify reuse from signed KeyPackage data, rejecting invalid placement. */
export declare function isReusableKeyPackage(keyPackage: KeyPackage): boolean;
