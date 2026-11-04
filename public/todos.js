import { $, requestJson } from './browser-utils.js';

const form = $('#add-todo');
const list = $('#todo-list');
const error = $('#todo-error');
let tasks = [];

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function button(text, className = 'button secondary') {
  const node = element('button', className, text);
  node.type = 'button';
  return node;
}
async function change(controls, action) {
  error.textContent = '';
  controls.forEach((control) => { control.disabled = true; });
  try {
    await action();
    await load();
  } catch (cause) {
    error.textContent = cause.message;
  } finally {
    controls.forEach((control) => { control.disabled = false; });
  }
}
const update = (task, input) => requestJson(`/api/todos/${task.id}`, {
  method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
});

function editTask(row, task) {
  const editor = element('form', 'todo-edit');
  const label = element('label', 'field');
  const input = element('input');
  input.value = task.title;
  input.required = true;
  input.maxLength = 200;
  label.append(element('span', '', 'Task title'), input);
  const save = button('Save', 'button primary');
  save.type = 'submit';
  const cancel = button('Cancel');
  cancel.addEventListener('click', render);
  editor.append(label, save, cancel);
  editor.addEventListener('submit', (event) => {
    event.preventDefault();
    void change([input, save, cancel], () => update(task, { title: input.value }));
  });
  row.replaceChildren(editor);
  input.focus();
  input.select();
}

function render() {
  const remaining = tasks.filter((task) => !task.completed).length;
  $('#todo-summary').textContent = `${remaining} remaining · ${tasks.length - remaining} completed`;
  $('#todo-empty').hidden = tasks.length > 0;
  list.replaceChildren(...tasks.map((task) => {
    const row = element('li', `todo-row${task.completed ? ' todo-complete' : ''}`);
    const check = element('input', 'todo-check');
    check.type = 'checkbox';
    check.checked = task.completed;
    check.setAttribute('aria-label', `${task.completed ? 'Mark incomplete' : 'Complete'}: ${task.title}`);
    const edit = button('Edit');
    edit.setAttribute('aria-label', `Edit: ${task.title}`);
    edit.addEventListener('click', () => editTask(row, task));
    const remove = button('Delete', 'text-danger');
    remove.setAttribute('aria-label', `Delete: ${task.title}`);
    const actions = element('div', 'todo-actions');
    remove.addEventListener('click', () => {
      const confirm = button('Delete task', 'text-danger');
      const cancel = button('Cancel');
      confirm.addEventListener('click', () => void change([confirm, cancel, check, edit], () => requestJson(`/api/todos/${task.id}`, { method: 'DELETE' })));
      cancel.addEventListener('click', () => actions.replaceChildren(edit, remove));
      actions.replaceChildren(confirm, cancel);
      confirm.focus();
    });
    check.addEventListener('change', async () => {
      await change([check, edit, remove], () => update(task, { completed: check.checked }));
      check.checked = task.completed;
    });
    actions.append(edit, remove);
    row.append(check, element('span', 'todo-title', task.title), actions);
    return row;
  }));
}
async function load() {
  tasks = await requestJson('/api/todos');
  render();
}
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const title = form.elements.title.value;
  await change([...form.elements], async () => {
    await requestJson('/api/todos', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title }) });
    form.reset();
  });
  form.elements.title.focus();
});
$('#sign-out').addEventListener('click', async () => {
  try {
    await requestJson('/api/auth/logout', { method: 'POST' });
    list.replaceChildren();
    location.replace('/login.html');
  } catch (cause) { error.textContent = cause.message; }
});
// Revalidate after history navigation to prevent displaying another account's rendered list.
window.addEventListener('pagehide', () => { list.replaceChildren(); $('#todo-card').hidden = true; });
window.addEventListener('pageshow', async (event) => {
  if (!event.persisted) return;
  try { await load(); $('#todo-card').hidden = false; } catch (cause) { error.textContent = cause.message; }
});
try {
  await load();
  $('#todo-card').hidden = false;
} catch (cause) { error.textContent = cause.message; }
