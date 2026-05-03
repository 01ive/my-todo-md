import * as vscode from 'vscode';
import { parseMarkdown } from './parser';

export function activate(context: vscode.ExtensionContext) {
    let disposable = vscode.commands.registerCommand('my-todo-md.openKanban', () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;

        // On garde une référence fixe au document
        const targetDocUri = editor.document.uri;

        const panel = vscode.window.createWebviewPanel(
            'todoKanban',
            'Mon Kanban: ' + editor.document.fileName.split('/').pop(),
            vscode.ViewColumn.Two,
            { enableScripts: true }
        );

        panel.webview.html = getWebviewContent(parseMarkdown(editor.document.getText()));

        panel.webview.onDidReceiveMessage(
            async message => {
                // On utilise targetDocUri plutôt que activeTextEditor
                const document = await vscode.workspace.openTextDocument(targetDocUri);
                
                switch (message.command) {
                    case 'toggle':
                        const lineIndex = message.line;
                        const lineText = document.lineAt(lineIndex).text;
                        let newText = lineText.includes('[ ]') ? lineText.replace('[ ]', '[x]') : lineText.replace('[x]', '[ ]');
                        
                        const editToggle = new vscode.WorkspaceEdit();
                        editToggle.replace(targetDocUri, document.lineAt(lineIndex).range, newText);
                        await vscode.workspace.applyEdit(editToggle);
                        break;

                    case 'move':
                        // On passe l'URI à moveTask pour qu'il soit autonome
                        await moveTask(targetDocUri, message.line, message.targetColumn);
                        break;
                }
            },
            undefined,
            context.subscriptions
        );

        const changeDocumentSubscription = vscode.workspace.onDidChangeTextDocument(e => {
            if (e.document === editor.document) {
                const newData = parseMarkdown(e.document.getText());
                panel.webview.postMessage({ command: 'update', data: newData });
            }
        });

        panel.onDidDispose(() => { changeDocumentSubscription.dispose(); }, null, context.subscriptions);
    });
    
    context.subscriptions.push(disposable);
}

// Fonction Helper pour déplacer le texte
async function moveTask(docUri: vscode.Uri, lineIndex: number, targetColumn: string) {
    const doc = await vscode.workspace.openTextDocument(docUri);
    
    // 1. Identifier le bloc (tâche + lignes indentées)
    let endLine = lineIndex;
    while (endLine + 1 < doc.lineCount && 
          (doc.lineAt(endLine + 1).text.startsWith('  ') || doc.lineAt(endLine + 1).text.startsWith('\t'))) {
        endLine++;
    }
    
    const rangeToRemove = new vscode.Range(new vscode.Position(lineIndex, 0), new vscode.Position(endLine + 1, 0));
    const taskContent = doc.getText(rangeToRemove);

    // 2. Trouver la colonne cible
    let destLine = -1;
    for (let i = 0; i < doc.lineCount; i++) {
        const text = doc.lineAt(i).text;
        if (text.startsWith('###') && text.toLowerCase().includes(targetColumn.toLowerCase())) {
            destLine = i;
            break;
        }
    }

    if (destLine !== -1) {
        const edit = new vscode.WorkspaceEdit();
        // Pour éviter les problèmes d'index qui changent :
        // Si on déplace vers le bas, on insère d'abord puis on supprime.
        // Si on déplace vers le haut, c'est l'inverse. 
        // Le plus simple : faire deux edits séparés ou gérer les positions.
        const insertPos = new vscode.Position(destLine + 1, 0);
        edit.insert(docUri, insertPos, taskContent);
        edit.delete(docUri, rangeToRemove);
        
        await vscode.workspace.applyEdit(edit);
    }
}

function getWebviewContent(columns: any[]) {
    const renderTasks = (tasks: any[]) => tasks.map((t: any) => `
        <div class="task ${t.status}" 
             onclick="toggleTask(${t.line})" 
             draggable="true" 
             ondragstart="drag(event)" 
             data-line="${t.line}">
            <strong>${t.title}</strong>
            <div class="meta">
                ${t.estimate ? `<span>⏱️ ${t.estimate}</span>` : ''}
                ${t.tag ? `<span class="tag">#${t.tag}</span>` : ''}
                ${t.assignee ? `<span class="assignee">👤 @${t.assignee}</span>` : ''}
            </div>
        </div>
    `).join('');

    const columnsHtml = columns.map(col => `
        <div class="column" 
             ondragover="allowDrop(event)" 
             ondragleave="dragLeave(event)"
             ondrop="drop(event)" 
             data-column="${col.name}">
            <h2>${col.name}</h2>
            <div class="task-list">
                ${renderTasks(col.tasks)}
            </div>
        </div>
    `).join('');

    return `<!DOCTYPE html>
    <html>
    <head>
        <style>
            body { display: flex; gap: 20px; font-family: sans-serif; background: #222; color: white; padding: 20px; }
            .column { flex: 1; background: #333; padding: 10px; border-radius: 8px; min-width: 250px; transition: background 0.2s; }
            .column.drag-over { background: #444; border: 2px dashed #007acc; }
            .task { background: #444; margin: 10px 0; padding: 10px; border-radius: 4px; border-left: 4px solid #007acc; cursor: grab; }
            .task:active { cursor: grabbing; }
            .task.done { opacity: 0.6; border-left-color: #4caf50; text-decoration: line-through; color: #888; }
            .tag { color: #ffab40; font-size: 0.8em; margin-left: 5px; }
            .meta { margin-top: 5px; font-size: 0.85em; opacity: 0.8; }
            .assignee { color: #4fc3f7; font-size: 0.8em; margin-left: 5px; font-weight: bold; }
        </style>
    </head>
    <body>
        <div id="kanban-container" style="display: flex; gap: 20px; width: 100%;">
            ${columnsHtml}
        </div>

        <script>
			const vscode = acquireVsCodeApi();

			function toggleTask(line) {
				// On évite que le clic ne soit déclenché pendant un drag
				vscode.postMessage({ command: 'toggle', line: line });
			}

			function allowDrop(ev) {
				ev.preventDefault();
				ev.currentTarget.classList.add('drag-over');
			}

			function dragLeave(ev) {
				ev.currentTarget.classList.remove('drag-over');
			}

			function drag(ev) {
				// UTILISER currentTarget pour être sûr d'avoir le div .task
				ev.dataTransfer.setData("line", ev.currentTarget.getAttribute("data-line"));
				ev.dataTransfer.effectAllowed = "move";
			}

			function drop(ev) {
				ev.preventDefault();
				const columnElt = ev.currentTarget;
				columnElt.classList.remove('drag-over');
				
				const line = ev.dataTransfer.getData("line");
				const targetColumn = columnElt.getAttribute("data-column");

				if (line && targetColumn) {
					vscode.postMessage({ 
						command: 'move', 
						line: parseInt(line), 
						targetColumn: targetColumn 
					});
				}
			}

            window.addEventListener('message', event => {
                const message = event.data;
                if (message.command === 'update') {
                    updateUI(message.data); 
                }
            });

            function updateUI(columns) {
                const container = document.getElementById('kanban-container');
                let html = '';
                
                columns.forEach(col => {
                    html += '<div class="column" ondragover="allowDrop(event)" ondragleave="dragLeave(event)" ondrop="drop(event)" data-column="' + col.name + '">';
                    html += '<h2>' + col.name + '</h2>';
                    
                    col.tasks.forEach(t => {
                        const statusClass = t.status || 'todo';
                        html += '<div class="task ' + statusClass + '" draggable="true" ondragstart="drag(event)" data-line="' + t.line + '" onclick="toggleTask(' + t.line + ')">';
                        html += '<strong>' + t.title + '</strong>';
                        
                        // --- AJOUT DE LA META ZONE ---
                        html += '<div class="meta">';
                        if (t.estimate) html += '<span>⏱️ ' + t.estimate + ' </span>';
                        if (t.tag) html += '<span class="tag">#' + t.tag + ' </span>';
                        if (t.assignee) html += '<span class="assignee">👤 @' + t.assignee + '</span>';
                        html += '</div>';
                        
                        html += '</div>';
                    });
                    html += '</div>';
                });
                
                container.innerHTML = html;
            }
        </script>
    </body>
    </html>`;
}

// This method is called when your extension is deactivated
export function deactivate() {}
