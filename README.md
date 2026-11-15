# EasyRead

让你更舒服地读论文。导入 PDF，第一段译好就能开始读。遇到难句，展开原文或对照 PDF，在段落旁划线、记笔记、问 AI。也可以直接读英文原文。

[下载桌面版](https://github.com/Edwardxlai/easyread/releases/latest) · [在线试读](https://edwardxlai.github.io/easyread/demo/) · [项目主页](https://edwardxlai.github.io/easyread/) · [English](README.en.md)

![译文与 PDF 原页对照](docs/images/pages.jpg)

## 安装

从上方下载 Windows 安装程序（`.exe`）、Apple 芯片 Mac 安装包（`.dmg`）或 Linux 应用（`.AppImage`）。首次打开遇到系统提示时，见[分平台安装说明](docs/guide.md#安装)。

<a id="run-from-source"></a>

也可以用 Python 3.10+ 从源码启动。Windows 双击 `start.cmd`，macOS 或 Linux 运行 `./start.sh`。

## 读第一篇论文

1. 把 PDF 拖进文献库，输入 arXiv 编号，或粘贴博客链接。选择目标语言，也可以直接读原文。
2. 要翻译或提问时，在设置中选择已登录的受支持 CLI，或配置模型 API。文献库存放在本机，翻译和提问会把相关内容交给所选模型处理。
3. 在侧栏并排看 PDF、写笔记。想找以前读过的内容，在文献库点「全库问 AI」，从回答中的引文回到原段落。

[完整使用指南](docs/guide.md) · [贡献指南](CONTRIBUTING.md) · [版本记录](CHANGELOG.md) · [贡献者](docs/guide.md#贡献者) · [MIT 许可及演示论文署名](docs/guide.md#许可)
