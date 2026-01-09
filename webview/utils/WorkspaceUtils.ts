/**
 * 工作区工具函数
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { t } from '../../backend/i18n';

/**
 * 检查路径是否应该被忽略
 */
export function shouldIgnorePath(relativePath: string, ignorePatterns: string[]): boolean {
  for (const pattern of ignorePatterns) {
    if (matchGlobPattern(relativePath, pattern)) {
      return true;
    }
  }
  return false;
}

/**
 * 简单的 glob 模式匹配
 * 支持 * 和 ** 通配符
 */
export function matchGlobPattern(filePath: string, pattern: string): boolean {
  const regexPattern = pattern
    .replace(/\\/g, '/')
    .replace(/\./g, '\\.')
    .replace(/\*\*/g, '<<<GLOBSTAR>>>')
    .replace(/\*/g, '[^/]*')
    .replace(/<<<GLOBSTAR>>>/g, '.*')
    .replace(/\//g, '[/\\\\]');
  
  const regex = new RegExp(`^${regexPattern}$|[/\\\\]${regexPattern}$|^${regexPattern}[/\\\\]|[/\\\\]${regexPattern}[/\\\\]`, 'i');
  return regex.test(filePath.replace(/\\/g, '/'));
}

/**
 * 获取当前工作区 URI
 */
export function getCurrentWorkspaceUri(): string | null {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  return workspaceFolder ? workspaceFolder.uri.toString() : null;
}

/**
 * 将绝对路径转换为相对路径
 */
export function getRelativePathFromAbsolute(absolutePath: string): string {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    throw new Error(t('webview.errors.noWorkspaceOpen'));
  }
  
  let filePath = absolutePath;
  if (absolutePath.startsWith('file://')) {
    const uri = vscode.Uri.parse(absolutePath);
    filePath = uri.fsPath;
  }
  
  const workspaceRoot = workspaceFolder.uri.fsPath;
  const relativePath = path.relative(workspaceRoot, filePath);
  
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return filePath;
  }
  
  return relativePath.replace(/\\/g, '/');
}

/**
 * 检查文件是否存在
 */
export async function checkFileExists(relativePath: string, workspaceUri: string): Promise<boolean> {
  try {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return false;
    }
    
    const workspaceFolder = workspaceFolders.find(f => f.uri.toString() === workspaceUri);
    if (!workspaceFolder) {
      return false;
    }
    
    const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, relativePath);
    
    try {
      const stat = await vscode.workspace.fs.stat(fileUri);
      return stat.type === vscode.FileType.File;
    } catch {
      return false;
    }
  } catch {
    return false;
  }
}

/**
 * 验证文件是否在工作区内
 */
export async function validateFileInWorkspace(filePath: string, workspaceUri?: string): Promise<{
  valid: boolean;
  relativePath?: string;
  workspaceUri?: string;
  error?: string;
  errorCode?: 'NO_WORKSPACE' | 'WORKSPACE_NOT_FOUND' | 'INVALID_URI' | 'NOT_FILE' | 'FILE_NOT_EXISTS' | 'NOT_IN_ANY_WORKSPACE' | 'NOT_IN_CURRENT_WORKSPACE' | 'UNKNOWN';
}> {
  try {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return { valid: false, error: t('webview.errors.noWorkspaceOpen'), errorCode: 'NO_WORKSPACE' };
    }
    
    let fileUri: vscode.Uri;
    
    if (filePath.startsWith('file://')) {
      try {
        fileUri = vscode.Uri.parse(filePath);
      } catch {
        return { valid: false, error: t('webview.errors.invalidFileUri'), errorCode: 'INVALID_URI' };
      }
    } else if (path.isAbsolute(filePath)) {
      fileUri = vscode.Uri.file(filePath);
    } else {
      const targetWorkspace = workspaceUri
        ? workspaceFolders.find(f => f.uri.toString() === workspaceUri)
        : workspaceFolders[0];
      if (!targetWorkspace) {
        return { valid: false, error: t('webview.errors.workspaceNotFound'), errorCode: 'WORKSPACE_NOT_FOUND' };
      }
      fileUri = vscode.Uri.joinPath(targetWorkspace.uri, filePath);
    }
    
    try {
      const stat = await vscode.workspace.fs.stat(fileUri);
      if (stat.type !== vscode.FileType.File) {
        return { valid: false, error: t('webview.errors.pathNotFile'), errorCode: 'NOT_FILE' };
      }
    } catch {
      return { valid: false, error: t('webview.errors.fileNotExists'), errorCode: 'FILE_NOT_EXISTS' };
    }
    
    const belongingWorkspace = vscode.workspace.getWorkspaceFolder(fileUri);
    
    if (!belongingWorkspace) {
      return {
        valid: false,
        error: t('webview.errors.fileNotInAnyWorkspace'),
        errorCode: 'NOT_IN_ANY_WORKSPACE'
      };
    }
    
    if (workspaceUri && belongingWorkspace.uri.toString() !== workspaceUri) {
      const belongingWorkspaceName = belongingWorkspace.name;
      return {
        valid: false,
        error: t('webview.errors.fileInOtherWorkspace', { workspaceName: belongingWorkspaceName }),
        errorCode: 'NOT_IN_CURRENT_WORKSPACE'
      };
    }
    
    const relativePath = vscode.workspace.asRelativePath(fileUri, false);
    
    return {
      valid: true,
      relativePath,
      workspaceUri: belongingWorkspace.uri.toString()
    };
  } catch (error: any) {
    return { valid: false, error: error.message, errorCode: 'UNKNOWN' };
  }
}
