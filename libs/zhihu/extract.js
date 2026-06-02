(() => {
  const el = document.getElementById('js-initialData');
  if (!el) return { error: 'js-initialData not found' };

  var data = JSON.parse(el.textContent);
  var state = data.initialState || {};
  var entities = state.entities || {};
  var questionMap = entities.questions || {};
  var answerMap = entities.answers || {};

  var pathMatch = location.pathname.match(/\/question\/(\d+)/);
  var qid = pathMatch ? pathMatch[1] : Object.keys(questionMap)[0];
  var q = questionMap[qid];

  var result = {
    title: (q && q.title) || "",
    questionDetail: (q && (q.detail || q.excerpt)) || "",
    topics: ((q && q.topics) || []).map(function(t) { return t.name || t.title || ""; }).filter(Boolean),
    followers: (q && q.followerCount) || 0,
    views: (q && q.visitCount) || 0,
    answerCount: (q && q.answerCount) || 0,
    answers: [],
  };

  // Collect answers
  var seenIds = {};
  var aid, a, author;
  for (aid in answerMap) {
    if (!answerMap.hasOwnProperty(aid) || seenIds[aid]) continue;
    seenIds[aid] = true;
    a = answerMap[aid];
    author = a.author || {};

    var content = a.content || "";
    // Strip HTML tags
    content = content.replace(/<[^>]+>/g, '');
    // Decode common entities
    content = content.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;/g, "'");

    result.answers.push({
      id: aid,
      author: author.name || author.headline || "",
      bio: author.headline || (author.badgeV2 && author.badgeV2.title) || "",
      votes: a.voteupCount || 0,
      commentCount: a.commentCount || 0,
      date: a.createdTime ? new Date(a.createdTime * 1000).toISOString().slice(0, 10) : "",
      location: a.location || author.location || "",
      content: content,
      excerpt: a.excerpt || "",
    });
  }

  // Sort by votes descending
  result.answers.sort(function(a, b) { return b.votes - a.votes; });

  return result;
})()
