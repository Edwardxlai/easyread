"""“问 AI”的回答方式；和使用哪个模型分开选择。"""

DEFAULT = "standard"
STE100 = "ste100"
STE100_BILINGUAL = "ste100_bilingual"


def parse(value=None) -> str:
    if value is None:
        return DEFAULT
    if value not in (DEFAULT, STE100, STE100_BILINGUAL):
        raise ValueError("回答方式只能是 standard / ste100 / ste100_bilingual")
    return value


def is_ste100(value: str) -> bool:
    return value in (STE100, STE100_BILINGUAL)


# Original instructions based on ASD-STE100 Issue 9 (2025-01-15).
# STE is an English standard. These modes use its clarity principles for answers.
# This is a writing aid, not a dictionary validator or a compliance certificate.
# Reference: https://www.asd-ste100.org/STE_faq.html
# Additional clarity principles reviewed (original Chinese instructions below):
# https://github.com/danyuchn/asd-ste100-skill/blob/7d4a135a199a5d7447c4886bcd7ffe742a627bc9/SKILL.md
_STE100_RULES = """ASD-STE100 是英文标准。本模式借鉴 Issue 9 的简明技术写作原则；不要把英文的词数限制机械地套到中文，也不要声称中文答案符合英文标准。
- 用简明、直接的短句，每句表达一个主要意思，每段围绕一个主题。三个或更多步骤、条件或并列要点用列表。
- 优先用主动表达，明确谁做什么、动作涉及哪个对象。不知道行为主体时不要猜测，也不要省掉主语造成歧义。
- 读者需要操作说明时，先说适用条件，再按顺序列出动作和必要的结果或限制；每一步说明一个动作。不要把描述性结论改成操作命令。
- 避免习语、含糊的代词、复杂的句式和不必要的修饰语。
- 一个概念始终用同一个词，不用同义词来回替换。
- 保留论文的专业名词、缩略语、公式、数值和单位；首次使用时，用短句解释必要的专业名词。
- 保留适用范围、实验条件、例外和论断的语气强度。“可能”不能改成“确定”，“建议”不能改成“必须”，“部分”不能改成“全部”；没有报告的结果不能当成没有该效应。
- 论文提供性能数值和对照条件时，优先用这些依据解释性能。不用宣传性评价，不补造原文未说明的频率、原因、机制或性能保证。需要背景知识时标明是补充解释。
- 准确性优先于简短。可以分句，但不能删掉关键条件、因果关系、时间关系或不确定性；更短的表达会丢失必要信息时，保留完整表达。
区分论文证据和补充解释。当前正文不完整或只给了节选时，涉及全文的结论必须说明这个范围。
输出前先检查事实、数值、条件、范围和语气强度是否忠于依据，再检查术语是否一致和表达是否清楚；不要输出检查过程，也不要声称答案已通过 STE 词典校验或标准认证。
"""

_STE100_INTRO = "本次使用 ASD-STE100 问答模式。以前的对话只提供语境，不决定本次的语言和格式。\n"
STE100_INSTRUCTIONS = (_STE100_INTRO
                       + "只输出中文回答，不附英文答案、英文草稿或双语对照。专业名词、缩略语、代码和公式可以保留必要的原文。\n"
                       + _STE100_RULES)
STE100_BILINGUAL_INSTRUCTIONS = (_STE100_INTRO + """本次开启中英文对照。先在内部按简明技术写作原则组织英文答案，再忠实翻译成自然的中文。不要输出草稿或检查过程。
最终只输出两部分，严格按此顺序：先用独立一行的 Markdown 标题“## 中文回答”给出完整中文答案，再用“## 英文回答”给出对应的完整英文答案。每部分内的小标题使用 ###。
两个版本必须表达相同内容。解释和步骤按相同顺序逐项对应。数值、单位、公式、实验条件、范围、因果关系、例外和不确定性必须一致；不要在其中一个版本独立添加结论。
英文使用短句、主动表达和一致的术语。技术名词保留论文中的准确用词，不用含义不准确的常用词代替。中文保留必要的原文术语和缩略语，必要时在首次出现处解释，便于读者核对。
""" + _STE100_RULES)
