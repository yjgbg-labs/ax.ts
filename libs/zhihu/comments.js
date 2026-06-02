(() => {
  const result = [];
  document.querySelectorAll('.Comments-container, [class*="Comments-container"], .CommentList, [class*="CommentList"]').forEach(list => {
    const section = { answerId: "", comments: [] };
    const parent = list.closest('.AnswerItem');
    if (parent) {
      const aEl = parent.querySelector('.AuthorInfo-name');
      if (aEl) section.answerId = aEl.textContent.trim();
    }
    list.querySelectorAll('.CommentItem, [class*="CommentItem"]').forEach(item => {
      const c = { author: "", isAuthor: false, content: "", date: "", votes: 0 };
      const u = item.querySelector('.UserLink-link, [class*="UserLink"]');
      if (u) c.author = u.textContent.trim();
      c.isAuthor = !!item.querySelector('[class*="AuthorTag"], [class*="authorTag"]');
      const ct = item.querySelector('[class*="CommentContent"], .RichText, [class*="commentContent"]');
      if (ct) c.content = ct.textContent.trim();
      const d = item.querySelector('[class*="CommentItem-time"]');
      if (d) c.date = d.textContent.trim();
      const vm = item.textContent.match(/(\d+)\s*$/m);
      if (vm) c.votes = parseInt(vm[1]) || 0;
      if (c.author) section.comments.push(c);
    });
    if (section.comments.length > 0) result.push(section);
  });
  return result;
})()
