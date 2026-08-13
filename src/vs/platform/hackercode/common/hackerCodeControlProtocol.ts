/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IJsonRpcNotification, IJsonRpcRequest, JsonRpcError, JsonRpcResponse } from '../../../base/common/jsonRpcProtocol.js';
import {
	IHackerCodeCreateRevisionRequest,
	IHackerCodePromoteRequest,
	IHackerCodePromoteResult,
	IHackerCodeReloadRevisionRequest,
	IHackerCodeRevisionManifest,
	IHackerCodeSafeModeRequest,
	IHackerCodeSetRevisionRequest,
	IHackerCodeState
} from './hackerCode.js';

export const HACKERCODE_CONTROL_MAX_EVAL_SOURCE_LENGTH = 256 * 1024;
export const HACKERCODE_CONTROL_REGISTER_RENDERER_METHOD = '$/hackerCode/registerRenderer';

export const enum HackerCodeControlJsonRpcErrorCode {
	InvalidRequest = -32600,
	MethodNotFound = -32601,
	InvalidParams = -32602,
	InternalError = -32603,
	RendererUnavailable = -32001,
	RequestTimeout = -32002,
}

export type HackerCodeControlMainMethod =
	| 'getState'
	| 'listRevisions'
	| 'createRevision'
	| 'promote'
	| 'setRevision'
	| 'safeMode'
	| 'reload'
	| 'eval'
	| 'refresh'
	| typeof HACKERCODE_CONTROL_REGISTER_RENDERER_METHOD;

export type HackerCodeControlRendererMethod = 'eval' | 'refresh';

export interface IHackerCodeEvalParams {
	readonly source: string;
	readonly windowId?: number;
}

export interface IHackerCodeRendererEvalParams {
	readonly source: string;
}

export interface IHackerCodeRefreshParams {
	readonly mode: 'soft' | 'module' | 'hard';
	readonly specifier?: string;
	readonly windowId?: number;
}

export interface IHackerCodeRendererRefreshParams {
	readonly mode: 'soft' | 'module' | 'hard';
	readonly specifier?: string;
}

export interface IHackerCodeRendererRegistrationParams {
	readonly windowId: number;
}

export type HackerCodeControlSerializedValue =
	| null
	| boolean
	| number
	| string
	| readonly HackerCodeControlSerializedValue[]
	| { readonly [key: string]: HackerCodeControlSerializedValue };

export interface IHackerCodeControlMainMethodMap {
	readonly getState: { readonly params: undefined; readonly result: IHackerCodeState };
	readonly listRevisions: { readonly params: undefined; readonly result: readonly IHackerCodeRevisionManifest[] };
	readonly createRevision: { readonly params: IHackerCodeCreateRevisionRequest; readonly result: IHackerCodeRevisionManifest };
	readonly promote: { readonly params: IHackerCodePromoteRequest; readonly result: IHackerCodePromoteResult };
	readonly setRevision: { readonly params: IHackerCodeSetRevisionRequest; readonly result: IHackerCodeState };
	readonly safeMode: { readonly params: IHackerCodeSafeModeRequest; readonly result: IHackerCodeState };
	readonly reload: { readonly params: IHackerCodeReloadRevisionRequest; readonly result: IHackerCodeState };
	readonly eval: { readonly params: IHackerCodeEvalParams; readonly result: HackerCodeControlSerializedValue };
	readonly refresh: { readonly params: IHackerCodeRefreshParams; readonly result: null };
	readonly '$/hackerCode/registerRenderer': { readonly params: IHackerCodeRendererRegistrationParams; readonly result: null };
}

export interface IHackerCodeControlRendererMethodMap {
	readonly eval: { readonly params: IHackerCodeRendererEvalParams; readonly result: HackerCodeControlSerializedValue };
	readonly refresh: { readonly params: IHackerCodeRendererRefreshParams; readonly result: null };
}

export type HackerCodeControlRequestParams =
	| undefined
	| IHackerCodeCreateRevisionRequest
	| IHackerCodePromoteRequest
	| IHackerCodeSetRevisionRequest
	| IHackerCodeSafeModeRequest
	| IHackerCodeReloadRevisionRequest
	| IHackerCodeEvalParams
	| IHackerCodeRefreshParams
	| IHackerCodeRendererRegistrationParams;

export interface IHackerCodeJsonRpcNullErrorResponse {
	readonly jsonrpc: '2.0';
	readonly id: null;
	readonly error: {
		readonly code: number;
		readonly message: string;
	};
}

export type ParsedHackerCodeJsonRpcMessage =
	| { readonly kind: 'request'; readonly message: IJsonRpcRequest }
	| { readonly kind: 'notification'; readonly message: IJsonRpcNotification }
	| { readonly kind: 'response'; readonly message: JsonRpcResponse }
	| { readonly kind: 'invalid'; readonly response: JsonRpcResponse | IHackerCodeJsonRpcNullErrorResponse };

/**
 * Parses the untrusted wire value before it reaches the generic JSON-RPC
 * helper. The WebSocket transport's event is typed for AHP messages, but this
 * control channel intentionally uses arbitrary JSON-RPC method strings.
 */
export function parseHackerCodeJsonRpcMessage(value: unknown): ParsedHackerCodeJsonRpcMessage {
	if (!isRecord(value) || value.jsonrpc !== '2.0') {
		return invalidRequest(value, 'Invalid JSON-RPC 2.0 request');
	}

	if (hasOwnProperty(value, 'method')) {
		if (typeof value.method !== 'string' || value.method.length === 0) {
			return invalidRequest(value, 'Invalid JSON-RPC method');
		}
		if (!hasOwnProperty(value, 'id')) {
			return {
				kind: 'notification',
				message: {
					jsonrpc: '2.0',
					method: value.method,
					...(hasOwnProperty(value, 'params') ? { params: value.params } : {})
				}
			};
		}
		if (!isRequestId(value.id)) {
			return invalidRequest(value, 'Invalid JSON-RPC request id');
		}
		return {
			kind: 'request',
			message: {
				jsonrpc: '2.0',
				id: value.id,
				method: value.method,
				...(hasOwnProperty(value, 'params') ? { params: value.params } : {})
			}
		};
	}

	if (!hasOwnProperty(value, 'id') || !isRequestId(value.id) || hasOwnProperty(value, 'result') === hasOwnProperty(value, 'error')) {
		return invalidRequest(value, 'Invalid JSON-RPC response');
	}
	if (hasOwnProperty(value, 'result')) {
		return {
			kind: 'response',
			message: { jsonrpc: '2.0', id: value.id, result: value.result }
		};
	}
	if (!isRecord(value.error) || typeof value.error.code !== 'number' || !Number.isSafeInteger(value.error.code) || typeof value.error.message !== 'string') {
		return invalidRequest(value, 'Invalid JSON-RPC error response');
	}
	return {
		kind: 'response',
		message: {
			jsonrpc: '2.0',
			id: value.id,
			error: {
				code: value.error.code,
				message: value.error.message,
				...(hasOwnProperty(value.error, 'data') ? { data: value.error.data } : {})
			}
		}
	};
}

/**
 * Validates method routing and the security-sensitive outer parameter shape.
 * Domain-specific revision validation remains in HackerCodeControlService.
 */
export function validateHackerCodeControlRequest(request: IJsonRpcRequest, target: 'main' | 'renderer'): HackerCodeControlRequestParams {
	if (target === 'renderer') {
		switch (request.method) {
			case 'eval':
				return validateEvalParams(request.params, false);
			case 'refresh':
				return validateRefreshParams(request.params, false);
			default:
				throw new JsonRpcError(HackerCodeControlJsonRpcErrorCode.MethodNotFound, `Method not found: ${request.method}`);
		}
	}

	switch (request.method) {
		case 'getState':
		case 'listRevisions':
			validateEmptyParams(request.params);
			return undefined;
		case 'createRevision':
			return validateCreateRevisionParams(request.params);
		case 'promote':
			return validatePromoteParams(request.params);
		case 'setRevision':
			return validateSetRevisionParams(request.params);
		case 'safeMode':
			return validateSafeModeParams(request.params);
		case 'reload':
			return validateReloadParams(request.params);
		case 'eval':
			return validateEvalParams(request.params, true);
		case 'refresh':
			return validateRefreshParams(request.params, true);
		case HACKERCODE_CONTROL_REGISTER_RENDERER_METHOD:
			return validateRegistrationParams(request.params);
		default:
			throw new JsonRpcError(HackerCodeControlJsonRpcErrorCode.MethodNotFound, `Method not found: ${request.method}`);
	}
}

function validateEmptyParams(params: unknown): void {
	if (params === undefined || params === null) {
		return;
	}
	if (!isRecord(params) || Object.keys(params).length !== 0) {
		throw new JsonRpcError(HackerCodeControlJsonRpcErrorCode.InvalidParams, 'Expected no parameters');
	}
}

function validateObjectParams<T extends object>(params: unknown, allowedKeys: readonly string[]): T {
	if (!isRecord(params) || !hasOnlyKeys(params, allowedKeys)) {
		throw new JsonRpcError(HackerCodeControlJsonRpcErrorCode.InvalidParams, 'Invalid method parameters');
	}
	return params as T;
}

function validateCreateRevisionParams(params: unknown): IHackerCodeCreateRevisionRequest {
	const value = validateObjectParams<IHackerCodeCreateRevisionRequest>(params, ['baseline', 'description', 'parentId', 'patches']);
	if (
		typeof value.baseline !== 'string'
		|| (value.description !== undefined && typeof value.description !== 'string')
		|| (value.parentId !== undefined && typeof value.parentId !== 'string')
		|| !Array.isArray(value.patches)
		|| !value.patches.every(patch => isRecord(patch)
			&& hasOnlyKeys(patch, ['name', 'content'])
			&& typeof patch.name === 'string'
			&& typeof patch.content === 'string')
	) {
		throw new JsonRpcError(HackerCodeControlJsonRpcErrorCode.InvalidParams, 'Invalid createRevision parameters');
	}
	return value;
}

function validatePromoteParams(params: unknown): IHackerCodePromoteRequest {
	const value = validateObjectParams<IHackerCodePromoteRequest>(params, ['revisionId', 'windowId', 'commitMessage']);
	if (
		typeof value.revisionId !== 'string'
		|| (value.commitMessage !== undefined && typeof value.commitMessage !== 'string')
	) {
		throw new JsonRpcError(HackerCodeControlJsonRpcErrorCode.InvalidParams, 'Invalid promote parameters');
	}
	validateWindowId(value.windowId);
	return value;
}

function validateSetRevisionParams(params: unknown): IHackerCodeSetRevisionRequest {
	const value = validateObjectParams<IHackerCodeSetRevisionRequest>(params, ['revisionId', 'mode', 'windowId']);
	if (
		typeof value.revisionId !== 'string'
		|| (value.mode !== undefined && value.mode !== 'normal' && value.mode !== 'recover')
	) {
		throw new JsonRpcError(HackerCodeControlJsonRpcErrorCode.InvalidParams, 'Invalid setRevision parameters');
	}
	if (value.windowId !== undefined) {
		validateWindowId(value.windowId);
	}
	return value;
}

function validateSafeModeParams(params: unknown): IHackerCodeSafeModeRequest {
	const value = validateObjectParams<IHackerCodeSafeModeRequest>(params, ['reason', 'windowId']);
	if (value.reason !== undefined && typeof value.reason !== 'string') {
		throw new JsonRpcError(HackerCodeControlJsonRpcErrorCode.InvalidParams, 'Invalid safeMode parameters');
	}
	if (value.windowId !== undefined) {
		validateWindowId(value.windowId);
	}
	return value;
}

function validateReloadParams(params: unknown): IHackerCodeReloadRevisionRequest {
	const value = validateObjectParams<IHackerCodeReloadRevisionRequest>(params, ['revisionId', 'windowId']);
	if (typeof value.revisionId !== 'string') {
		throw new JsonRpcError(HackerCodeControlJsonRpcErrorCode.InvalidParams, 'Invalid reload parameters');
	}
	validateWindowId(value.windowId);
	return value;
}

function validateEvalParams(params: unknown, allowWindowId: boolean): IHackerCodeEvalParams | IHackerCodeRendererEvalParams {
	const value = validateObjectParams<IHackerCodeEvalParams>(params, allowWindowId ? ['source', 'windowId'] : ['source']);
	if (typeof value.source !== 'string' || new TextEncoder().encode(value.source).byteLength > HACKERCODE_CONTROL_MAX_EVAL_SOURCE_LENGTH) {
		throw new JsonRpcError(
			HackerCodeControlJsonRpcErrorCode.InvalidParams,
			`Eval source must be a string no larger than ${HACKERCODE_CONTROL_MAX_EVAL_SOURCE_LENGTH} UTF-8 bytes`
		);
	}
	if (value.windowId !== undefined) {
		validateWindowId(value.windowId);
	}
	return value;
}

function validateRefreshParams(params: unknown, allowWindowId: boolean): IHackerCodeRefreshParams | IHackerCodeRendererRefreshParams {
	const value = validateObjectParams<IHackerCodeRefreshParams>(params, allowWindowId ? ['mode', 'specifier', 'windowId'] : ['mode', 'specifier']);
	if (value.mode !== 'soft' && value.mode !== 'module' && value.mode !== 'hard') {
		throw new JsonRpcError(HackerCodeControlJsonRpcErrorCode.InvalidParams, 'Invalid refresh mode');
	}
	if (value.mode === 'module') {
		if (typeof value.specifier !== 'string' || value.specifier.length === 0) {
			throw new JsonRpcError(HackerCodeControlJsonRpcErrorCode.InvalidParams, 'Module refresh requires a specifier');
		}
	} else if (value.specifier !== undefined) {
		throw new JsonRpcError(HackerCodeControlJsonRpcErrorCode.InvalidParams, 'A specifier is only valid for module refresh');
	}
	if (value.windowId !== undefined) {
		validateWindowId(value.windowId);
	}
	return value;
}

function validateRegistrationParams(params: unknown): IHackerCodeRendererRegistrationParams {
	const value = validateObjectParams<IHackerCodeRendererRegistrationParams>(params, ['windowId']);
	validateWindowId(value.windowId);
	return value;
}

function validateWindowId(windowId: number): void {
	if (!Number.isSafeInteger(windowId) || windowId <= 0) {
		throw new JsonRpcError(HackerCodeControlJsonRpcErrorCode.InvalidParams, 'Invalid window id');
	}
}

function invalidRequest(value: unknown, message: string): ParsedHackerCodeJsonRpcMessage {
	const id = isRecord(value) && isRequestId(value.id) ? value.id : null;
	if (id === null) {
		return {
			kind: 'invalid',
			response: {
				jsonrpc: '2.0',
				id: null,
				error: {
					code: HackerCodeControlJsonRpcErrorCode.InvalidRequest,
					message
				}
			}
		};
	}
	return {
		kind: 'invalid',
		response: {
			jsonrpc: '2.0',
			id,
			error: {
				code: HackerCodeControlJsonRpcErrorCode.InvalidRequest,
				message
			}
		}
	};
}

function isRequestId(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwnProperty<T extends object, K extends PropertyKey>(value: T, key: K): value is T & Record<K, unknown> {
	return Object.prototype.hasOwnProperty.call(value, key);
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
	return Object.keys(value).every(key => allowedKeys.includes(key));
}

