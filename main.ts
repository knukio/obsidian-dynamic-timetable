import {
  Plugin,
  WorkspaceLeaf,
  ItemView,
  App,
  TFile,
  PluginSettingTab,
  Setting,
  Notice,
} from 'obsidian';

interface Task {
  task: string;
  startTime: Date | null;
  estimate: string | null;
  isChecked: boolean;
}

interface DynamicTimetableSettings {
  filePath: string | null;
  showEstimate: boolean;
  showStartTime: boolean;
  showEstimateInTaskName: boolean;
  showStartTimeInTaskName: boolean;
  showBufferTime: boolean;
  showProgressBar: boolean;
  intervalTime: number;
  taskEstimateDelimiter: string;
  startTimeDelimiter: string;
  headerNames: string[];
  dateDelimiter: string;
  enableOverdueNotice: boolean;
  [key: string]: string | boolean | string[] | number | null | undefined;
}

declare module 'obsidian' {
  interface Workspace {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    on(eventName: 'layout-ready', callback: () => any, ctx?: any): EventRef;
  }
}

export default class DynamicTimetable extends Plugin {
  settings: DynamicTimetableSettings;
  targetFile: TFile | null = null;
  taskParser: TaskParser;
  timetableView: TimetableView | null = null;

  static DEFAULT_SETTINGS: DynamicTimetableSettings = {
    filePath: null,
    showEstimate: false,
    showStartTime: false,
    showEstimateInTaskName: false,
    showStartTimeInTaskName: true,
    showBufferTime: true,
    showProgressBar: true,
    intervalTime: 1,
    taskEstimateDelimiter: ';',
    startTimeDelimiter: '@',
    dateDelimiter: '',
    enableOverdueNotice: true,
    headerNames: ['Tasks', 'Estimate', 'Start', 'End'],
  };

  async onload() {
    console.log('DynamicTimetable: onload');

    this.settings = {
      ...DynamicTimetable.DEFAULT_SETTINGS,
      ...(await this.loadData()),
    };
    this.addSettingTab(new DynamicTimetableSettingTab(this.app, this));
    this.taskParser = TaskParser.fromSettings(this.settings);

    this.registerView('Timetable', (leaf: WorkspaceLeaf) => {
      this.timetableView = new TimetableView(leaf, this);
      return this.timetableView;
    });

    if (this.app.workspace.layoutReady) {
      this.initTimetableView();
    } else {
      this.registerEvent(
        this.app.workspace.on('layout-ready', this.initTimetableView.bind(this))
      );
    }
    this.registerCommands();
  }

  onunload(): void {
    this.closeTimetable();
  }

  async updateSetting<T extends keyof DynamicTimetableSettings>(
    settingName: T,
    newValue: DynamicTimetableSettings[T]
  ): Promise<void> {
    this.settings[settingName] = newValue;
    await this.saveData(this.settings);
    await this.updateOpenTimetableViews();
  }

  private registerCommands(): void {
    this.addCustomCommand('toggle-timetable', 'Show/Hide Timetable', () => {
      if (this.isTimetableOpen()) {
        this.closeTimetable();
      } else {
        this.openTimetable();
      }
    });

    this.addCustomCommand('init-timetable', 'Initialize Timetable', () =>
      this.initTimetableView()
    );

    this.addCustomCommand('complete-task', 'Complete Task', async () => {
      this.checkTargetFile();
      if (this.targetFile === null || this.taskParser === undefined) {
        return;
      }
      const content = await this.app.vault.read(this.targetFile);
      const task = this.taskParser.filterAndParseTasks(content)[0];
      if (task && this.timetableView) {
        await this.timetableView.completeTask(task);
      }
    });

    this.addCustomCommand('interrupt-task', 'Interrupt Task', async () => {
      if (this.targetFile === null) {
        return;
      }
      const content = await this.app.vault.read(this.targetFile);
      const task = this.taskParser.filterAndParseTasks(content)[0];
      if (task && this.timetableView) {
        await this.timetableView.interruptTask(task);
      }
    });
  }

  private addCustomCommand(id: string, name: string, callback: any) {
    this.addCommand({
      id: id,
      name: name,
      callback: callback,
    });
  }

  async initTimetableView() {
    if (!this.isTimetableOpen()) {
      this.openTimetable();
    } else {
      this.updateOpenTimetableViews();
    }
  }

  async updateOpenTimetableViews() {
    for (const leaf of this.app.workspace.getLeavesOfType('Timetable')) {
      const view = leaf.view;
      if (view instanceof TimetableView) {
        this.checkTargetFile();
        await view.update();
      }
    }
  }

  isTimetableOpen(): boolean {
    return this.app.workspace.getLeavesOfType('Timetable').length > 0;
  }

  async openTimetable() {
    this.checkTargetFile();
    const leaf = this.app.workspace.getRightLeaf(false);
    leaf.setViewState({ type: 'Timetable' });
    this.app.workspace.revealLeaf(leaf);
  }

  closeTimetable() {
    this.app.workspace.detachLeavesOfType('Timetable');
  }

  checkTargetFile() {
    const abstractFile = this.settings.filePath
      ? this.app.vault.getAbstractFileByPath(this.settings.filePath)
      : this.app.workspace.getActiveFile();

    if (abstractFile instanceof TFile) {
      this.targetFile = abstractFile;
    } else {
      this.targetFile = null;
      new Notice('No active file or active file is not a Markdown file');
    }
  }
}

class TimetableView extends ItemView {
  private intervalId: ReturnType<typeof setInterval> | undefined;
  private overdueNotice: Notice | null = null;

  private taskManager: TaskManager;
  private tableRenderer: TableRenderer;
  private progressBarManager: ProgressBarManager;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: DynamicTimetable
  ) {
    super(leaf);
    this.containerEl.addClass('Timetable');

    this.taskManager = new TaskManager(plugin);
    this.tableRenderer = new TableRenderer(plugin, this.containerEl);
    this.progressBarManager = new ProgressBarManager(plugin, this.containerEl);

    plugin.registerEvent(
      this.app.vault.on('modify', async (file) => {
        if (file === this.plugin.targetFile) {
          this.update();
        }
      })
    );
  }

  getViewType(): string {
    return 'Timetable';
  }

  getDisplayText(): string {
    return 'Timetable';
  }

  async onOpen(): Promise<void> {
    await this.update();
  }

  async onClose(): Promise<void> {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }

    if (this.overdueNotice) {
      this.overdueNotice.hide();
      this.overdueNotice = null;
    }
  }

  async update() {
    if (!this.plugin.targetFile) {
      return;
    }
    let tasks = await this.taskManager.initializeTasks();
    await this.tableRenderer.renderTable(tasks);
    this.setupInterval(tasks);
  }

  setupInterval(tasks: Task[]) {
    if (tasks.length === 0) {
      return;
    }
    if (this.intervalId) {
      clearInterval(this.intervalId);
      if (this.overdueNotice) {
        this.overdueNotice.hide();
        this.overdueNotice = null;
      }
    }
    this.intervalId = setInterval(() => {
      const topTask = tasks[0];
      const duration =
        topTask && topTask.startTime
          ? (new Date().getTime() - topTask.startTime.getTime()) / 1000
          : 0;
      const topTaskEstimate = Number(topTask.estimate) * 60 || 0;
      this.progressBarManager.createOrUpdateProgressBar(
        duration,
        topTaskEstimate
      );
    }, this.plugin.settings.intervalTime * 1000);
  }

  async completeTask(task: Task): Promise<void> {
    await this.taskManager.completeTask(task);
    this.update();
  }

  async interruptTask(task: Task): Promise<void> {
    await this.taskManager.interruptTask(task);
    this.update();
  }
}

class TaskManager {
  private taskParser: TaskParser;
  private plugin: DynamicTimetable;

  constructor(plugin: DynamicTimetable) {
    this.plugin = plugin;
  }

  async initializeTasks() {
    if (!this.plugin.targetFile) {
      return [];
    }
    const content = await this.plugin.app.vault.cachedRead(
      this.plugin.targetFile
    );
    this.taskParser = TaskParser.fromSettings(this.plugin.settings);
    let tasks = this.taskParser.filterAndParseTasks(content);

    if (tasks.length > 0 && tasks[0].startTime === null) {
      tasks[0].startTime = new Date(this.plugin.targetFile.stat.mtime);
    }
    return tasks;
  }

  async completeTask(task: Task): Promise<void> {
    console.log('completeTask called with task:', task);
    if (!this.plugin.targetFile || !task.estimate) {
      return;
    }

    let content = await this.plugin.app.vault.cachedRead(
      this.plugin.targetFile
    );
    let elapsedTime = this.getElapsedTime(task);
    content = this.updateTaskInContent(content, task, elapsedTime);

    await this.plugin.app.vault.modify(this.plugin.targetFile, content);
  }

  async interruptTask(task: Task): Promise<void> {
    console.log('interruptTask called with task:', task);
    if (!this.plugin.targetFile || !task.estimate) {
      return;
    }

    let content = await this.plugin.app.vault.cachedRead(
      this.plugin.targetFile
    );
    let elapsedTime = this.getElapsedTime(task);
    let remainingTime = Math.floor(parseFloat(task.estimate) - elapsedTime);
    content = this.updateTaskInContent(
      content,
      task,
      elapsedTime,
      remainingTime
    );

    await this.plugin.app.vault.modify(this.plugin.targetFile, content);
  }

  private getElapsedTime(task: Task): number {
    if (!task.startTime && this.plugin.targetFile) {
      task.startTime = new Date(this.plugin.targetFile.stat.mtime);
    }
    let elapsedTime = task.startTime
      ? (new Date().getTime() - task.startTime.getTime()) / 60000
      : 0;
    return Math.floor(elapsedTime);
  }

  private updateTaskInContent(
    content: string,
    task: Task,
    elapsedTime: number,
    remainingTime?: number
  ): string {
    const taskRegex = new RegExp(
      `^- \\[ \\] ${task.task.replace(
        /[.*+?^${}()|[\]\\]/g,
        '\\$&'
      )}\\s*${this.plugin.settings.taskEstimateDelimiter.replace(
        /[.*+?^${}()|[\]\\]/g,
        '\\$&'
      )}\\s*${task.estimate}$`,
      'm'
    );

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (taskRegex.test(lines[i])) {
        let newTaskLine = `- [x] ${task.task} ${
          this.plugin.settings.taskEstimateDelimiter
        } ${elapsedTime.toFixed(0)}`;
        if (remainingTime !== undefined) {
          newTaskLine += `\n- [ ] ${task.task} ${
            this.plugin.settings.taskEstimateDelimiter
          } ${remainingTime.toFixed(0)}`;
        }
        lines[i] = newTaskLine;
        break;
      }
    }
    return lines.join('\n');
  }
}

class TableRenderer {
  private static readonly MILLISECONDS_IN_MINUTE = 60000;
  private static readonly LATE_CLASS = 'late';
  private static readonly ON_TIME_CLASS = 'on-time';
  private static readonly BUFFER_TIME_CLASS = 'dt-buffer-time';
  private static readonly BUFFER_TIME_NAME = 'Buffer Time';
  private static readonly INIT_BUTTON_TEXT = 'Init';

  private plugin: DynamicTimetable;
  private contentEl: HTMLElement;
  private progressBarManager: ProgressBarManager;

  constructor(plugin: DynamicTimetable, contentEl: HTMLElement) {
    this.plugin = plugin;
    this.contentEl = contentEl;
    this.contentEl.classList.add('dt-content');
    this.progressBarManager = new ProgressBarManager(plugin, contentEl);
  }

  async renderTable(tasks: Task[]): Promise<void> {
    this.contentEl.empty();
    if (this.plugin.settings.showProgressBar) {
      this.progressBarManager.createOrUpdateProgressBar(0, 0);
    }
    const initButton = this.createButton();
    const scheduleTable = this.initializeTable(tasks);
    this.contentEl.appendChild(initButton);
    this.contentEl.appendChild(scheduleTable);
  }

  initializeTable(tasks: Task[]) {
    const scheduleTable = this.createTable();
    const tableHead = scheduleTable.createTHead();
    const tableBody = scheduleTable.createTBody();

    tableHead.appendChild(this.createTableHeader());
    this.appendTableBodyRows(tableBody, tasks);

    return scheduleTable;
  }

  createButton() {
    const initButton = this.contentEl.createEl('button', {
      text: TableRenderer.INIT_BUTTON_TEXT,
    });
    initButton.addEventListener('click', async () => {
      await this.plugin.initTimetableView();
      new Notice('Timetable initialized!');
    });
    return initButton;
  }

  private createTable(): HTMLTableElement {
    const table = this.contentEl.createEl('table');
    table.classList.add('dt-table');
    return table;
  }

  private createTableHeader(): HTMLTableRowElement {
    const { headerNames, showEstimate, showStartTime } = this.plugin.settings;
    const [
      taskHeaderName,
      estimateHeaderName,
      startTimeHeaderName,
      endHeaderName,
    ] = headerNames;

    const tableHeaderValues = [taskHeaderName];
    if (showEstimate) {
      tableHeaderValues.push(estimateHeaderName);
    }
    if (showStartTime) {
      tableHeaderValues.push(startTimeHeaderName);
    }
    tableHeaderValues.push(endHeaderName);
    return this.createTableRow(tableHeaderValues, true);
  }

  private appendTableBodyRows(
    tableBody: HTMLTableSectionElement,
    tasks: Task[]
  ): void {
    const { showEstimate, showStartTime } = this.plugin.settings;

    let currentTime = new Date();
    let previousEndTime: Date | null = null;

    for (const task of tasks) {
      const { task: parsedTaskName, startTime, estimate } = task;
      const minutes = estimate ? parseInt(estimate) : null;
      if (startTime) {
        currentTime = new Date(startTime);
      } else if (previousEndTime) {
        currentTime = previousEndTime;
      }

      const endTime = minutes
        ? new Date(
            currentTime.getTime() +
              minutes * TableRenderer.MILLISECONDS_IN_MINUTE
          )
        : null;

      if (this.plugin.settings.showBufferTime && startTime && previousEndTime) {
        const bufferMinutes = Math.floor(
          (new Date(startTime).getTime() - previousEndTime.getTime()) /
            TableRenderer.MILLISECONDS_IN_MINUTE
        );
        tableBody.appendChild(this.createBufferRow(bufferMinutes));
      }

      const rowClass = startTime
        ? previousEndTime && new Date(startTime) < previousEndTime
          ? TableRenderer.LATE_CLASS
          : TableRenderer.ON_TIME_CLASS
        : null;

      const tableRowValues = [parsedTaskName];
      if (showEstimate && estimate) {
        tableRowValues.push(`${estimate}m`);
      }
      if (showStartTime) {
        tableRowValues.push(this.formatTime(currentTime));
      }
      if (endTime) {
        tableRowValues.push(this.formatTime(endTime));
      }
      tableBody.appendChild(
        this.createTableRow(tableRowValues, false, rowClass)
      );

      if (endTime) {
        previousEndTime = endTime;
        currentTime = endTime;
      }
    }
  }

  private createTableCell(value: string, isHeader = false): HTMLElement {
    const cell = document.createElement(isHeader ? 'th' : 'td');
    cell.textContent = value;
    return cell;
  }

  private createTableRow(
    rowValues: string[],
    isHeader = false,
    rowClass: string | null = null
  ): HTMLTableRowElement {
    const row = document.createElement('tr');
    if (rowClass) {
      row.classList.add(rowClass);
    }
    rowValues.forEach((value) => {
      const cell = this.createTableCell(value, isHeader);
      row.appendChild(cell);
    });
    return row;
  }

  private createBufferRow(bufferMinutes: number): HTMLTableRowElement {
    const bufferRow = document.createElement('tr');
    bufferRow.classList.add(TableRenderer.BUFFER_TIME_CLASS);
    const bufferNameCell = this.createTableCell(TableRenderer.BUFFER_TIME_NAME);
    bufferRow.appendChild(bufferNameCell);
    const bufferTimeCell = document.createElement('td');
    bufferTimeCell.textContent = `${bufferMinutes}m`;
    bufferTimeCell.setAttribute('colspan', '3');
    bufferRow.appendChild(bufferTimeCell);
    return bufferRow;
  }

  private formatTime(date: Date): string {
    return new Intl.DateTimeFormat(navigator.language, {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(date);
  }
}

class ProgressBarManager {
  private overdueNotice: Notice | null = null;
  private static readonly PROGRESS_BAR_CLASS = 'dt-progress-bar';
  private static readonly PROGRESS_BAR_OVERDUE_CLASS =
    'dt-progress-bar-overdue';

  private plugin: DynamicTimetable;
  private contentEl: HTMLElement;

  constructor(plugin: DynamicTimetable, contentEl: HTMLElement) {
    this.plugin = plugin;
    this.contentEl = contentEl;
  }

  createOrUpdateProgressBar(duration: number, estimate: number): void {
    let progressBar = this.contentEl.querySelector(
      '.' + ProgressBarManager.PROGRESS_BAR_CLASS
    ) as HTMLElement;
    if (!progressBar) {
      progressBar = this.contentEl.createEl('div');
      progressBar.addClass(ProgressBarManager.PROGRESS_BAR_CLASS);
    }
    const width = Math.min((duration / estimate) * 100, 100);
    this.updateProgressBarStyle(progressBar, width);
  }

  private updateProgressBarStyle(
    progressBar: HTMLElement,
    width: number
  ): void {
    progressBar.style.width = width + '%';
    if (width === 100) {
      progressBar.addClass(ProgressBarManager.PROGRESS_BAR_OVERDUE_CLASS);
      this.createNotice();
    } else {
      progressBar.removeClass(ProgressBarManager.PROGRESS_BAR_OVERDUE_CLASS);
      if (this.overdueNotice) {
        this.overdueNotice.hide();
        this.overdueNotice = null;
      }
    }
  }

  private createNotice(): void {
    if (!this.overdueNotice && this.plugin.settings.enableOverdueNotice) {
      this.overdueNotice = new Notice('Are you finished?', 0);
    }
  }
}

class TaskParser {
  private static readonly TASK_NAME_REGEX = /^[-+*]\s*\[\s*.\s*\]/;
  private static readonly LINK_REGEX = /\[\[([^\[\]]*\|)?([^\[\]]+)\]\]/g;
  private static readonly MARKDOWN_LINK_REGEX = /\[([^\[\]]+)\]\(.+?\)/g;

  private taskNameRegex: RegExp;
  private linkRegex: RegExp;
  private markdownLinkRegex: RegExp;
  private estimateRegex: RegExp;
  private timeRegex: RegExp;
  private dateTimeRegex: RegExp;
  private dateDelimiter: RegExp;

  constructor(
    private separator: string,
    private startTimeDelimiter: string,
    dateDelimiter: string,
    private showStartTimeInTaskName: boolean,
    private showEstimateInTaskName: boolean
  ) {
    this.taskNameRegex = TaskParser.TASK_NAME_REGEX;
    this.linkRegex = TaskParser.LINK_REGEX;
    this.markdownLinkRegex = TaskParser.MARKDOWN_LINK_REGEX;
    this.estimateRegex = new RegExp(`\\${separator}\\s*\\d+\\s*`);
    this.timeRegex = new RegExp(
      `\\${startTimeDelimiter}\\s*(\\d{1,2}\\:?\\d{2})`
    );
    this.dateTimeRegex = new RegExp(
      `\\${startTimeDelimiter}\\s*(\\d{4}-\\d{2}-\\d{2}T\\d{1,2}\\:?\\d{2})`
    );
    this.dateDelimiter = dateDelimiter ? new RegExp(dateDelimiter) : /(?!x)x/;
  }

  static fromSettings(settings: DynamicTimetableSettings): TaskParser {
    return new TaskParser(
      settings.taskEstimateDelimiter,
      settings.startTimeDelimiter,
      settings.dateDelimiter,
      settings.showStartTimeInTaskName,
      settings.showEstimateInTaskName
    );
  }

  public getTopUncompletedTask(content: string): Task | null {
    const tasks = this.filterAndParseTasks(content);
    for (const task of tasks) {
      if (!task.isChecked) {
        return task;
      }
    }
    return null;
  }

  public filterAndParseTasks(content: string): Task[] {
    const lines = content.split('\n').map((line) => line.trim());
    const currentDate = new Date();
    let nextDay = 0;

    const tasks = lines.flatMap((line) => {
      if (new RegExp(this.dateDelimiter).test(line)) {
        nextDay += 1;
        return [];
      }

      if (
        !line.startsWith('- [ ]') &&
        !line.startsWith('+ [ ]') &&
        !line.startsWith('* [ ]')
      ) {
        return [];
      }

      if (
        !line.includes(this.separator) &&
        !line.includes(this.startTimeDelimiter)
      ) {
        return [];
      }

      const taskName = this.parseTaskName(line);
      const startTime = this.parseStartTime(line, currentDate, nextDay);
      const estimate = this.parseEstimate(line);
      const isChecked =
        line.startsWith('- [x]') ||
        line.startsWith('+ [x]') ||
        line.startsWith('* [x]');

      return {
        task: taskName,
        startTime: startTime,
        estimate: estimate,
        isChecked: isChecked,
      };
    });

    return tasks;
  }

  public parseTaskName(taskName: string): string {
    taskName = taskName
      .replace(this.taskNameRegex, '')
      .trim()
      .replace(this.linkRegex, '$2')
      .replace(this.markdownLinkRegex, '$1')
      .trim();

    const startTimeRegex = new RegExp(
      `\\${this.startTimeDelimiter}\\s*(?:\\d{4}-\\d{2}-\\d{2}T)?(\\d{1,2}\\:?\\d{2})`
    );

    if (this.showStartTimeInTaskName) {
      taskName = taskName.replace(
        startTimeRegex,
        (match, p1) => `${this.startTimeDelimiter}${p1}`
      );
    } else {
      taskName = taskName.replace(startTimeRegex, '').trim();
    }

    if (!this.showEstimateInTaskName) {
      taskName = taskName.replace(this.estimateRegex, '').trim();
    }

    return taskName;
  }

  public parseStartTime(
    task: string,
    currentDate: Date,
    nextDay: number
  ): Date | null {
    const timeMatch = task.match(this.timeRegex);
    const dateTimeMatch = task.match(this.dateTimeRegex);

    if (dateTimeMatch) {
      const parsedDateTime = new Date(dateTimeMatch[1]);
      if (!isNaN(parsedDateTime.getTime())) {
        return parsedDateTime;
      }
    } else if (timeMatch) {
      const timeSplit =
        timeMatch[1].split(':').length == 1
          ? timeMatch[1].length == 3
            ? [timeMatch[1].substring(0, 1), timeMatch[1].substring(1, 3)]
            : [timeMatch[1].substring(0, 2), timeMatch[1].substring(2, 4)]
          : timeMatch[1].split(':');
      const [hours, minutes] = timeSplit.map(Number);

      const startDate = new Date(currentDate.getTime());
      startDate.setDate(startDate.getDate() + nextDay);
      startDate.setHours(hours, minutes, 0, 0);

      return startDate;
    }

    return null;
  }

  public parseEstimate(task: string): string | null {
    const regex = new RegExp(`\\${this.separator}\\s*(\\d+)\\s*`);
    const match = task.match(regex);
    return match ? match[1] : null;
  }
}

class DynamicTimetableSettingTab extends PluginSettingTab {
  plugin: DynamicTimetable;

  constructor(app: App, plugin: DynamicTimetable) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    this.containerEl.empty();

    this.createSetting(
      'File Path',
      'Enter the path to the Markdown file to get task list from. Leave blank to use active file.',
      'filePath',
      'text',
      '/path/to/target/file.md'
    );
    this.createSetting('Show Estimate Column', '', 'showEstimate', 'toggle');
    this.createSetting('Show Start Time Column', '', 'showStartTime', 'toggle');
    this.createSetting(
      'Show Estimate in Task Name',
      '',
      'showEstimateInTaskName',
      'toggle'
    );
    this.createSetting(
      'Show Start Time in Task Name',
      '',
      'showStartTimeInTaskName',
      'toggle'
    );
    this.createSetting('Show Buffer Time Rows', '', 'showBufferTime', 'toggle');
    this.createSetting(
      'Task/Estimate Delimiter',
      '',
      'taskEstimateDelimiter',
      'text',
      ';'
    );
    this.createSetting(
      'Start Time Delimiter',
      '',
      'startTimeDelimiter',
      'text',
      '@'
    );

    const headerNames = this.plugin.settings.headerNames.join(', ');
    this.createSetting(
      'Header Names',
      'Enter header names, separated by commas.',
      'headerNames',
      'text',
      headerNames
    );

    this.createSetting(
      'Show Progress Bar',
      'If enabled, displays a progress bar based on the top task estimate.',
      'showProgressBar',
      'toggle'
    );
    if (this.plugin.settings.showProgressBar) {
      this.createSetting(
        'Interval Time (Seconds)',
        'Set the interval for updating the progress bar.',
        'intervalTime',
        'text',
        '1'
      );
    }
    this.createSetting(
      'Date Delimiter',
      'Enter a regex that matches the delimiter for a new day.',
      'dateDelimiter',
      'text',
      '^---$'
    );
    this.createSetting(
      'Enable Overdue Notice',
      '',
      'enableOverdueNotice',
      'toggle'
    );
  }

  /**
   * Creates a new setting with the given parameters.
   * @param {string} name - The name of the setting.
   * @param {string} desc - The description of the setting.
   * @param {string} key - The key for the setting.
   * @param {'text' | 'toggle'} type - The type of the setting.
   * @param {string} [placeholder] - The placeholder for the setting.
   */
  createSetting(
    name: string,
    desc: string,
    key: string,
    type: 'text' | 'toggle',
    placeholder?: string
  ) {
    if (key === 'headerNames') {
      this.createHeaderNamesSetting(placeholder || '');
      return;
    }

    if (type === 'text') {
      this.createTextSetting(name, desc, key, placeholder);
    } else if (type === 'toggle') {
      this.createToggleSetting(name, desc, key);
    }
  }

  createTextSetting(
    name: string,
    desc: string,
    key: string,
    placeholder?: string
  ) {
    const setting = new Setting(this.containerEl).setName(name).setDesc(desc);
    setting.addText((text) => {
      const el = text
        .setPlaceholder(placeholder || '')
        .setValue((this.plugin.settings[key] as string) || '');
      el.inputEl.addEventListener('blur', async (event) => {
        const value = (event.target as HTMLInputElement).value;
        await this.plugin.updateSetting(key, value);
      });
      return el;
    });
  }

  createToggleSetting(name: string, desc: string, key: string) {
    const setting = new Setting(this.containerEl).setName(name).setDesc(desc);
    setting.addToggle((toggle) =>
      toggle
        .setValue(!!(this.plugin.settings[key] as boolean))
        .onChange(async (value) => {
          await this.plugin.updateSetting(key, value);
          this.display();
        })
    );
  }

  createHeaderNamesSetting(headerNames: string) {
    new Setting(this.containerEl).setName('Header Names').addText((text) => {
      const el = text.setValue(headerNames);
      el.inputEl.style.width = '-webkit-fill-available';
      el.inputEl.addEventListener('blur', async (event) => {
        const value = (event.target as HTMLInputElement).value
          .split(',')
          .map((s) => s.trim());
        await this.plugin.updateSetting('headerNames', value);
        this.display();
      });
      return el;
    });
  }
}
