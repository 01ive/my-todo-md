import * as assert from 'assert';
import { parseMarkdown } from '../parser';
import { buildGanttTasks } from '../extension';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
// import * as myExtension from '../../extension';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('Sample test', () => {
		assert.strictEqual(-1, [1, 2, 3].indexOf(5));
		assert.strictEqual(-1, [1, 2, 3].indexOf(0));
	});

	test('parses elapsed time and task completion', () => {
		const columns = parseMarkdown([
			'### Work',
			'- [ ] Direct time $2h',
			'- [ ] Minutes $5m',
			'- [ ] Days $5d',
			'- [ ] Estimated progress ~4h $25%',
			'- [ ] Progress without estimate $25%',
			'- [ ] Invalid progress $101%'
		].join('\n'));
		const tasks = columns[0].tasks;

		assert.strictEqual(tasks[0].title, 'Direct time');
		assert.strictEqual(tasks[0].timeSpent, '2h');
		assert.strictEqual(tasks[1].timeSpent, '5m');
		assert.strictEqual(tasks[2].timeSpent, '5d');
		assert.strictEqual(tasks[3].title, 'Estimated progress');
		assert.strictEqual(tasks[3].estimate, '4h');
		assert.strictEqual(tasks[3].completion, 25);
		assert.strictEqual(tasks[4].completion, 25);
		assert.strictEqual(tasks[5].completion, undefined);
		assert.strictEqual(tasks[5].title, 'Invalid progress $101%');
	});

	test('builds parallel Gantt dates and excludes completed tasks', () => {
		const columns = parseMarkdown([
			'### Work',
			'- [ ] Longer task ~2d 2026-10-10',
			'- [ ] Parallel task ~1d 2026-10-10',
			'- [x] Closed task ~3d 2026-10-10'
		].join('\n'));
		const ganttTasks = buildGanttTasks(columns);

		assert.deepStrictEqual(ganttTasks.map(task => task.title), ['Longer task', 'Parallel task']);
		assert.strictEqual(new Date(ganttTasks[0].start).toISOString(), '2026-10-09T00:00:00.000Z');
		assert.strictEqual(new Date(ganttTasks[1].start).toISOString(), '2026-10-10T00:00:00.000Z');
		assert.strictEqual(ganttTasks[0].end, ganttTasks[1].end);
	});
});
