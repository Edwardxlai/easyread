import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { EditorContext } from '@tiptap/react';
import { Toolbar, ToolbarGroup, ToolbarSeparator } from '@/components/tiptap-ui-primitive/toolbar';
import { HeadingDropdownMenu } from '@/components/tiptap-ui/heading-dropdown-menu';
import { ListDropdownMenu } from '@/components/tiptap-ui/list-dropdown-menu';
import { MarkButton } from '@/components/tiptap-ui/mark-button';
import { BlockquoteButton } from '@/components/tiptap-ui/blockquote-button';
import { UndoRedoButton } from '@/components/tiptap-ui/undo-redo-button';
import { ColorHighlightPopover } from '@/components/tiptap-ui/color-highlight-popover';
import { CodeBlockButton } from '@/components/tiptap-ui/code-block-button';
import { LinkButton, LinkContent } from '@/components/tiptap-ui/link-popover';
import { Button, ButtonGroup } from '@/components/tiptap-ui-primitive/button';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/tiptap-ui-primitive/popover';
import { Card, CardBody } from '@/components/tiptap-ui-primitive/card';
import { ChevronDownIcon } from '@/components/tiptap-icons/chevron-down-icon';
import { LinkIcon } from '@/components/tiptap-icons/link-icon';
import { ImagePlusIcon } from '@/components/tiptap-icons/image-plus-icon';
import { ArrowLeftIcon } from '@/components/tiptap-icons/arrow-left-icon';
import { Separator } from '@/components/tiptap-ui-primitive/separator';
import { TableIcon, ZoomIcon } from './note-control-icons';
import { SuperscriptIcon } from '@/components/tiptap-icons/superscript-icon';

const PR = window.PR;
function MoreTools({ editor, onMath }) {
  const imageInput = React.useRef<HTMLInputElement | null>(null);
  const [open, setOpen] = React.useState(false);
  const [link, setLink] = React.useState(false);
  const [zoomMenu, setZoomMenu] = React.useState(false);
  const [zoom, setZoom] = React.useState(() => PR.ls.get("easyread-note-zoom", 100));
  const zoomButton = React.useRef<HTMLButtonElement | null>(null);
  const close = () => { setOpen(false); setLink(false); setZoomMenu(false); editor.view.focus(); };
  const applyZoom = (value: number) => {
    setZoom(value);
    document.querySelector<HTMLElement>('.pn-workspace').style.setProperty('--note-zoom', String(value / 100));
    PR.ls.set('easyread-note-zoom', value);
    close();
  };
  const insertImages = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files || []);
    event.currentTarget.value = '';
    PR.noteLibraries.insertNoteImages(editor, files);
    close();
  };
  return (
    <Popover open={open} onOpenChange={value => { setOpen(value); if (!value) { setLink(false); setZoomMenu(false); } }}>
      <PopoverTrigger asChild>
        <Button type="button" data-style="ghost" aria-label={PR.t('更多工具')} tooltip={PR.t('更多工具')}>
          <span className="tiptap-button-text">{PR.t('更多')}</span>
          <ChevronDownIcon className="tiptap-button-dropdown-small" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" aria-label={PR.t('更多工具')} onCloseAutoFocus={event => event.preventDefault()} onEscapeKeyDown={event => { event.stopPropagation(); editor.view.focus(); }}>
        {link ? <LinkContent editor={editor} onSetLink={close} /> : zoomMenu ? (
          <Card><CardBody>
            <Button type="button" data-style="ghost" autoFocus aria-label={PR.t('返回更多工具')} onClick={() => { setZoomMenu(false); requestAnimationFrame(() => zoomButton.current?.focus()); }}>
              <ArrowLeftIcon className="tiptap-button-icon" /><span className="tiptap-button-text">{PR.t('笔记缩放')}</span>
            </Button>
            <Separator />
            <ButtonGroup orientation="vertical" aria-label={PR.t('笔记缩放')}>
              {[75, 90, 100, 110, 125, 150, 175, 200].map(value => (
                <Button key={value} type="button" data-style="ghost" data-active-state={zoom === value ? 'on' : 'off'} aria-pressed={zoom === value} onClick={() => applyZoom(value)}><span className="tiptap-button-icon" aria-hidden="true" /><span className="tiptap-button-text">{value}%</span></Button>
              ))}
            </ButtonGroup>
          </CardBody></Card>
        ) : (
          <Card><CardBody><ButtonGroup orientation="vertical">
            <input ref={imageInput} type="file" accept="image/*" multiple hidden aria-label={PR.t('上传笔记图片')} onChange={insertImages} />
            <Button type="button" data-style="ghost" onClick={() => imageInput.current?.click()}>
              <ImagePlusIcon className="tiptap-button-icon" /><span className="tiptap-button-text">{PR.t('插入图片')}</span>
            </Button>
            <Button ref={zoomButton} type="button" data-style="ghost" aria-label={PR.t('笔记缩放')} onClick={() => setZoomMenu(true)}>
              <ZoomIcon className="tiptap-button-icon" /><span className="tiptap-button-text">{PR.t('笔记缩放')}</span>
              <span className="pn-menu-value">{zoom}%</span><ChevronDownIcon className="tiptap-button-dropdown-small pn-submenu-arrow" />
            </Button>
            <BlockquoteButton editor={editor} text={PR.t('引用块')} aria-label={PR.t('引用块')} showTooltip={false} onClick={close} />
            <MarkButton editor={editor} type="strike" text={PR.t('删除线')} aria-label={PR.t('删除线')} showTooltip={false} onClick={close} />
            <LinkButton aria-label={PR.t('链接')} showTooltip={false} onClick={() => setLink(true)}>
              <LinkIcon className="tiptap-button-icon" /><span className="tiptap-button-text">{PR.t('链接')}</span>
            </LinkButton>
            <Button type="button" data-style="ghost" aria-label={PR.t('插入公式')} onClick={() => { close(); onMath(); }}>
              <SuperscriptIcon className="tiptap-button-icon" /><span className="tiptap-button-text">{PR.t('插入公式')}</span>
            </Button>
            <Button type="button" data-style="ghost" aria-label={PR.t('插入表格')} onClick={() => { editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(); close(); }}>
              <TableIcon className="tiptap-button-icon" /><span className="tiptap-button-text">{PR.t('插入表格')}</span>
            </Button>
            <CodeBlockButton editor={editor} text={PR.t('代码块')} aria-label={PR.t('代码块')} showTooltip={false} onClick={close} />
          </ButtonGroup></CardBody></Card>
        )}
      </PopoverContent>
    </Popover>
  );
}

export function mountNoteToolbar(element, editor, onMath) {
  const root = createRoot(element);
  root.render(
    <EditorContext.Provider value={{ editor }}>
      <Toolbar aria-label={PR.t('文字格式')}>
        <ToolbarGroup>
          <UndoRedoButton action="undo" aria-label={PR.t('撤销')} tooltip={PR.t('撤销')} />
          <UndoRedoButton action="redo" aria-label={PR.t('重做')} tooltip={PR.t('重做')} />
        </ToolbarGroup>
        <ToolbarSeparator />
        <ToolbarGroup>
          <HeadingDropdownMenu portal levels={[1, 2, 3, 4, 5, 6]} aria-label={PR.t('段落格式')} tooltip={PR.t('段落格式')} />
          <ListDropdownMenu portal types={['bulletList', 'orderedList', 'taskList']} aria-label={PR.t('列表')} tooltip={PR.t('列表')} />
        </ToolbarGroup>
        <ToolbarSeparator />
        <ToolbarGroup>
          <MarkButton type="bold" aria-label={PR.t('粗体')} tooltip={PR.t('粗体')} />
          <MarkButton type="italic" aria-label={PR.t('斜体')} tooltip={PR.t('斜体')} />
          <MarkButton type="underline" aria-label={PR.t('下划线')} tooltip={PR.t('下划线')} />
          <ColorHighlightPopover aria-label={PR.t('高亮')} tooltip={PR.t('高亮')} colors={[
            { label: PR.t('绿色高亮'), value: 'var(--tt-color-highlight-green)', border: 'var(--tt-color-highlight-green-contrast)' },
            { label: PR.t('蓝色高亮'), value: 'var(--tt-color-highlight-blue)', border: 'var(--tt-color-highlight-blue-contrast)' },
            { label: PR.t('红色高亮'), value: 'var(--tt-color-highlight-red)', border: 'var(--tt-color-highlight-red-contrast)' },
            { label: PR.t('紫色高亮'), value: 'var(--tt-color-highlight-purple)', border: 'var(--tt-color-highlight-purple-contrast)' },
            { label: PR.t('黄色高亮'), value: 'var(--tt-color-highlight-yellow)', border: 'var(--tt-color-highlight-yellow-contrast)' },
          ]} />
        </ToolbarGroup>
        <ToolbarSeparator />
        <ToolbarGroup>
          <MoreTools editor={editor} onMath={onMath} />
        </ToolbarGroup>
      </Toolbar>
    </EditorContext.Provider>
  );
  return () => root.unmount();
}
