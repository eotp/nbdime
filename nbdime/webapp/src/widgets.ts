// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.
'use strict';

import {
  RenderMime
} from 'jupyterlab/lib/rendermime';

import {
  OutputWidget
} from 'jupyterlab/lib/notebook/output-area';


import {
  loadModeByMIME
} from 'jupyterlab/lib/codemirror';

import {
  Widget
} from 'phosphor-widget';

import {
  Panel, PanelLayout
} from 'phosphor-panel';

import 'codemirror/lib/codemirror.css';

import {
  DiffView, MergeView, MergeViewEditorConfiguration
} from './mergeview';

import {
  sanitize
} from 'sanitizer';

import {
  nbformat
} from 'jupyterlab/lib/notebook/notebook/nbformat';

import {
  valueIn
} from './util';

import {
  CellDiffModel, NotebookDiffModel, IDiffModel,
  IStringDiffModel, StringDiffModel, OutputDiffModel
} from './diffmodel';


const NBDIFF_CLASS = 'jp-Notebook-diff';

const ROOT_METADATA_CLASS = 'jp-Metadata-diff';
const CELLDIFF_CLASS = 'jp-Cell-diff';

const SOURCE_ROW_CLASS = 'jp-Cellrow-source';
const METADATA_ROW_CLASS = 'jp-Cellrow-metadata';
const OUTPUTS_ROW_CLASS = 'jp-Cellrow-outputs';

const TWOWAY_DIFF_CLASS = 'jp-Diff-twoway';
const ADDED_DIFF_CLASS = 'jp-Diff-added';
const DELETED_DIFF_CLASS = 'jp-Diff-deleted';
const UNCHANGED_DIFF_CLASS = 'jp-Diff-unchanged';

const DIFF_CLASSES = ['jp-Diff-base', 'jp-Diff-remote'];

const COLLAPISBLE_HEADER = 'jp-Collapsible-header';
const COLLAPISBLE_HEADER_ICON = 'jp-Collapsible-header-icon';
const COLLAPISBLE_HEADER_ICON_OPEN = 'jp-Collapsible-header-icon-opened';
const COLLAPISBLE_HEADER_ICON_CLOSED = 'jp-Collapsible-header-icon-closed';
const COLLAPISBLE_SLIDER = 'jp-Collapsible-slider';
const COLLAPSIBLE_OPEN = 'jp-Collapsible-opened';
const COLLAPSIBLE_CLOSED = 'jp-Collapsible-closed';
const COLLAPSIBLE_CONTAINER = 'jp-Collapsible-container';


/**
 * A list of outputs considered safe.
 */
const safeOutputs = ['text/plain', 'text/latex', 'image/png', 'image/jpeg',
                    'application/vnd.jupyter.console-text'];

/**
 * A list of outputs that are sanitizable.
 */
const sanitizable = ['text/svg', 'text/html'];

/**
 * A list of MIME types that can be shown as string diff.
 */
const stringDiffMimeTypes = ['text/html', 'text/plain'];


/**
 * CollapsibleWidget
 */
class CollapsibleWidget extends Widget {
  static createHeader(headerTitle?: string): HTMLSpanElement {
    let header = document.createElement('div');
    header.className = COLLAPISBLE_HEADER;
    if (headerTitle) {
      //let title = document.createElement('span');
      header.innerText = headerTitle;
      //header.appendChild(title);
    }
    let button = document.createElement('span');
    button.className = COLLAPISBLE_HEADER_ICON;
    header.appendChild(button)

    return header;
  }

  constructor(public inner: Widget, headerTitle?: string, collapsed?: boolean) {
    super();
    let constructor = this.constructor as typeof CollapsibleWidget;
    let header = constructor.createHeader(headerTitle);
    this.button = header.getElementsByClassName(
      COLLAPISBLE_HEADER_ICON)[0] as HTMLElement;
    header.onclick = this.toggleCollapsed.bind(this);
    this.node.appendChild(header);
    this.container = document.createElement('div');
    this.container.className = COLLAPSIBLE_CONTAINER;
    this.slider = document.createElement('div');
    this.slider.classList.add(COLLAPISBLE_SLIDER);
    this.slider.appendChild(inner.node)
    this.container.appendChild(this.slider);
    this.node.appendChild(this.container);

    this.slider.classList.add(
      collapsed === true ?
      COLLAPSIBLE_CLOSED :
      COLLAPSIBLE_OPEN);
    this.button.classList.add(
      collapsed === true ?
      COLLAPISBLE_HEADER_ICON_CLOSED :
      COLLAPISBLE_HEADER_ICON_OPEN);
  }

  toggleCollapsed(): void {
    let slider = this.slider;
    let button = this.button;
    if (this.collapsed) {
      slider.classList.remove(COLLAPSIBLE_CLOSED);
      slider.classList.add(COLLAPSIBLE_OPEN);
      button.classList.remove(COLLAPISBLE_HEADER_ICON_CLOSED);
      button.classList.add(COLLAPISBLE_HEADER_ICON_OPEN);

    } else {
      slider.classList.remove(COLLAPSIBLE_OPEN);
      slider.classList.add(COLLAPSIBLE_CLOSED);
      button.classList.remove(COLLAPISBLE_HEADER_ICON_OPEN);
      button.classList.add(COLLAPISBLE_HEADER_ICON_CLOSED);
    }
  }

  get collapsed(): boolean {
    return this.slider.classList.contains(COLLAPSIBLE_CLOSED);
  }

  slider: HTMLElement;
  container: HTMLElement;
  button: HTMLElement;
}


/**
 * A wrapper view for showing StringDiffModels in a MergeView
 */
class NbdimeMergeView extends Widget {
  constructor(remote: IStringDiffModel, editorClasses: string[],
              local?: IStringDiffModel, merged?: any) {
    super();
    let opts: MergeViewEditorConfiguration = {remote: remote};
    opts.collapseIdentical = true;
    opts.local = local ? local : null;
    //opts.merged = merged ? merged : null;
    this._mergeview = new MergeView(this.node, opts);
    this._editors = [];
    if (this._mergeview.left) {
      this._editors.push(this._mergeview.left);
    }
    if (this._mergeview.right) {
      this._editors.push(this._mergeview.right);
    }
    if (this._mergeview.merge) {
      this._editors.push(this._mergeview.merge);
    }

    if (remote.mimetype) {
      // Set the editor mode to the MIME type.
      for (let e of this._editors) {
        loadModeByMIME(e.orig, remote.mimetype);
      }
      loadModeByMIME(this._mergeview.base, remote.mimetype);
    }
  }

  protected _mergeview: MergeView;
  protected _editors: DiffView[];
}


/**
 * Widget for outputs with renderable MIME data.
 */
class RenderableOutputView extends Widget {
  constructor(model: OutputDiffModel, editorClass: string[],
              rendermime: RenderMime<Widget>) {
    super();
    this._rendermime = rendermime;
    let bdata = model.base as nbformat.IOutput;
    let rdata = model.remote as nbformat.IOutput;
    this.layout = new PanelLayout();

    let ci = 0;
    if (bdata){
      let widget = this.createOutput(bdata, false);
      (this.layout as PanelLayout).addChild(widget);
      widget.addClass(editorClass[ci++]);
    }
    if (rdata && rdata !== bdata) {
      let widget = this.createOutput(rdata, false);
      (this.layout as PanelLayout).addChild(widget);
      widget.addClass(editorClass[ci++]);
    }
  }

  /**
   * Checks if all MIME types of a MIME bundle are safe or can be sanitized.
   */
  static safeOrSanitizable(bundle: nbformat.MimeBundle) {
    let keys = Object.keys(bundle);
    for (let key of keys) {
      if (valueIn(key, safeOutputs)) {
        continue;
      } else if (valueIn(key, sanitizable)) {
        let out = bundle[key];
        if (typeof out === 'string') {
          continue;
        } else {
          return false;
        }
      } else {
        return false;
      }
    }
    return true;
  }

  /**
   * Checks if a cell output can be rendered as untrusted (either safe or
   * sanitizable)
   */
  static canRenderUntrusted(model: OutputDiffModel): boolean {
    let toTest: nbformat.IOutput[] = [];
    if (model.base) {
      toTest.push(model.base);
    }
    if (model.remote && model.remote !== model.base) {
      toTest.push(model.remote);
    }
    for (let o of toTest) {
      if (valueIn(o.output_type, ['execute_result', 'display_data'])) {
        let bundle = (o as any).data as nbformat.MimeBundle;
        if (!this.safeOrSanitizable(bundle)) {
          return false;
        }
      } else if (valueIn(o.output_type, ['stream', 'error'])) {
        // Unknown output type
        return false;
      }
    }
    return true;
  }

  /**
   * Create a widget which renders the given cell output
   */
  protected createOutput(output: nbformat.IOutput, trusted: boolean): Widget {
    let widget = new OutputWidget({rendermime: this._rendermime});
    widget.render(output, trusted);
    return widget;
  }

  _sanitized: boolean;
  _rendermime: RenderMime<Widget>;
}


/**
 * CellDiffWidget for cell changes
 */
export
class CellDiffWidget extends Panel {
  /**
   *
   */
  constructor(model: CellDiffModel, rendermime: RenderMime<Widget>,
        public mimetype: string) {
    super();
    this.addClass(CELLDIFF_CLASS);
    this._model = model;
    this._rendermime = rendermime;

    this.init();
  }

  protected init() {
    var model = this.model;

    // Add 'cell added/deleted' notifiers, as appropriate
    var CURR_DIFF_CLASSES = DIFF_CLASSES.slice();  // copy
    if (model.added) {
      let widget = new Widget();
      widget.node.textContent = 'Cell added';
      this.addChild(widget);
      this.addClass(ADDED_DIFF_CLASS);
      CURR_DIFF_CLASSES = DIFF_CLASSES.slice(0, 1);
    } else if (model.deleted) {
      let widget = new Widget();
      widget.node.textContent = 'Cell deleted';
      this.addChild(widget);
      this.addClass(DELETED_DIFF_CLASS);
      CURR_DIFF_CLASSES = DIFF_CLASSES.slice(1, 2);
    } else if (model.unchanged) {
      this.addClass(UNCHANGED_DIFF_CLASS);
    } else {
      this.addClass(TWOWAY_DIFF_CLASS);
    }

    // Add inputs and outputs, on a row-by-row basis
    let sourceView = this.createView(
      model.source, model, CURR_DIFF_CLASSES);
    sourceView.addClass(SOURCE_ROW_CLASS);
    this.addChild(sourceView);

    if (model.metadata && !model.metadata.unchanged) {
      let metadataView = this.createView(
        model.metadata, model, CURR_DIFF_CLASSES);
      metadataView.addClass(METADATA_ROW_CLASS);
      this.addChild(metadataView);
    }
    if (model.outputs && model.outputs.length > 0) {
      let container = new Panel();
      let changed = false;
      for (let o of model.outputs) {
        let outputsWidget = this.createView(
          o, model, CURR_DIFF_CLASSES);
        container.addChild(outputsWidget);
        changed = changed || !o.unchanged || o.added || o.deleted;
      }
      let header = changed ? 'Outputs changed' : 'Outputs unchanged'
      let collapser = new CollapsibleWidget(container, header, !changed);
      collapser.addClass(OUTPUTS_ROW_CLASS);
      this.addChild(collapser);
    }
  }

  /**
   * Create a new sub-view.
   */
  createView(model: IDiffModel, parent: CellDiffModel, editorClasses: string[]): Widget {
    let view: Widget = null;
    if (model instanceof StringDiffModel) {
      if (model.unchanged && parent.cellType == 'markdown') {
        let renderer = this._rendermime.getRenderer('text/markdown');
        view = renderer.render('text/markdown', model.base);
      } else {
        view = new NbdimeMergeView(model as IStringDiffModel, editorClasses);
      }
    } else if (model instanceof OutputDiffModel) {
      // Take one of three actions, depending on output types
      // 1) Text-type output: Show a MergeView with text diff.
      // 2) Renderable types: Side-by-side comparison.
      // 3) Unknown types: Stringified JSON diff.
      let tmodel = model as OutputDiffModel;
      let renderable = RenderableOutputView.canRenderUntrusted(tmodel);
      for (let mt of this._rendermime.order) {
        let key = tmodel.hasMimeType(mt);
        if (key) {
          if (!renderable || valueIn(mt, stringDiffMimeTypes)) {
            view = new NbdimeMergeView(tmodel.stringify(key), editorClasses);
          } else if (renderable) {
            view = new RenderableOutputView(tmodel, editorClasses, this._rendermime);
          }
          break;
        }
      }
      if (!view) {
        view = new NbdimeMergeView(tmodel.stringify(), editorClasses);
      }
    } else {
      throw 'Unrecognized model type.'
    }
    if (model.collapsible) {
      view = new CollapsibleWidget(
        view, model.collapsibleHeader, model.startCollapsed);
    }
    let container = new Panel();
    if (model.added && !parent.added) {
      let addSpacer = new Widget()
      addSpacer.node.textContent = 'Output added';
      container.addChild(addSpacer);
      container.addClass(ADDED_DIFF_CLASS);
    } else if (model.deleted && !parent.deleted) {
      let delSpacer = new Widget()
      delSpacer.node.textContent = 'Output deleted';
      container.addChild(delSpacer);
      container.addClass(DELETED_DIFF_CLASS);
    } else if (model.unchanged && !parent.unchanged) {
      container.addClass(UNCHANGED_DIFF_CLASS);
    } else {
      container.addClass(TWOWAY_DIFF_CLASS);
    }
    container.addChild(view);
    return container;
  }

  /**
   * Get the model for the widget.
   *
   * #### Notes
   * This is a read-only property.
   */
  get model(): CellDiffModel {
    return this._model;
  }

  protected _model: CellDiffModel = null;
  protected _rendermime: RenderMime<Widget> = null;
}


/**
 * MetadataWidget for changes to Notebook-level metadata
 */
export
class MetadataDiffWidget extends Panel {
  constructor(model: IDiffModel) {
    super();
    this._model = model;
    console.assert(!model.added && !model.deleted);
    this.addClass(ROOT_METADATA_CLASS);
    this.init();
  }

  init() {
    let model = this._model;
    if (!model.unchanged) {
      this.addClass(TWOWAY_DIFF_CLASS);
      console.assert(model instanceof StringDiffModel)
      let view: Widget = new NbdimeMergeView(
        model as StringDiffModel, DIFF_CLASSES);
      if (model.collapsible) {
        view = new CollapsibleWidget(
          view, model.collapsibleHeader, model.startCollapsed);
      }
      this.addChild(view);
    }
  }

  private _model: IDiffModel;
}


/**
 * NotebookDiffWidget
 */
export
class NotebookDiffWidget extends Widget {
  constructor(model: NotebookDiffModel, rendermime: RenderMime<Widget>) {
    super();
    this._model = model;
    this._rendermime = rendermime;
    let layout = this.layout = new PanelLayout();

    this.addClass(NBDIFF_CLASS);

    if (model.metadata) {
      layout.addChild(new MetadataDiffWidget(model.metadata));
    }
    for (var c of model.cells) {
      layout.addChild(new CellDiffWidget(c, rendermime, model.mimetype));
    }
  }

  /**
   * Get the model for the widget.
   *
   * #### Notes
   * This is a read-only property.
   */
  get model(): NotebookDiffModel {
    return this._model;
  }

  private _model: NotebookDiffModel;
  private _rendermime: RenderMime<Widget> = null;
}