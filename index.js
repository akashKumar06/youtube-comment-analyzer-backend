import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import { LanguageServiceClient } from "@google-cloud/language";

const app = express();
const PORT = process.env.PORT || 3000;

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const GOOGLE_APPLICATION_CREDENTIALS =
  process.env.GOOGLE_APPLICATION_CREDENTIALS;

let languageClient;
try {
  if (GOOGLE_APPLICATION_CREDENTIALS) {
    languageClient = new LanguageServiceClient({
      keyFilename: GOOGLE_APPLICATION_CREDENTIALS,
    });
    console.log("Google Cloud Natural Language Client initialized.");
  } else {
    console.warn(
      "GOOGLE_APPLICATION_CREDENTIALS environment variable not set. Natural Language API will not function."
    );
  }
} catch (error) {
  console.error(
    "Failed to initialize Google Cloud Natural Language Client:",
    error
  );
  languageClient = null;
}

app.use(cors());
app.use(express.json());

app.get("/comments", async (req, res) => {
  let videoCategory = "Unknown";

  try {
    const videoId = req.query.videoId;
    let pageToken = req.query.pageToken || null;

    if (!videoId) {
      return res.status(400).json({ message: "Missing videoId parameter" });
    }

    if (!YOUTUBE_API_KEY) {
      console.error("YOUTUBE_API_KEY environment variable is not set!");
      return res.status(500).json({
        message: "Server configuration error: YouTube API Key missing.",
      });
    }

    if (!languageClient) {
      console.error(
        "Natural Language Client is not initialized or failed to initialize."
      );
      return res.status(500).json({
        message:
          "Server configuration error: Natural Language API client not ready.",
      });
    }

    try {
      const videoApiUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${videoId}&key=${YOUTUBE_API_KEY}`;
      const videoResponse = await fetch(videoApiUrl);
      const videoData = await videoResponse.json();

      if (videoResponse.ok && videoData.items && videoData.items.length > 0) {
        const categoryId = videoData.items[0].snippet.categoryId;
        const categoryMap = {
          1: "Film & Animation",
          2: "Autos & Vehicles",
          10: "Music",
          15: "Pets & Animals",
          17: "Sports",
          19: "Travel & Events",
          20: "Gaming",
          22: "People & Blogs",
          23: "Comedy",
          24: "Entertainment",
          25: "News & Politics",
          26: "Howto & Style",
          27: "Education",
          28: "Science & Technology",
          29: "Nonprofits & Activism",
          30: "Movies",
          31: "Anime/Animation",
          32: "Action/Adventure",
          33: "Classics",
          34: "Comedy (Film)",
          35: "Documentary",
          36: "Drama",
          37: "Family",
          38: "Foreign",
          39: "Horror",
          40: "Sci-Fi/Fantasy",
          41: "Thriller",
          42: "Shorts",
          43: "Shows",
          44: "Trailers",
        };
        videoCategory = categoryMap[categoryId] || `Category ID: ${categoryId}`;
      } else {
        console.warn(
          `Could not fetch video details for ${videoId}:`,
          videoData
        );
        videoCategory = "Unknown or Not Found";
      }
    } catch (videoError) {
      console.error(
        `Error fetching video category for ${videoId}:`,
        videoError.message
      );
      videoCategory = "Error Fetching";
    }

    // --- Fetch Comments from YouTube ---
    const maxResults = 100;
    let allComments = [];
    let fetchedCommentCount = 0;
    const maxCommentsToFetch = 500; // Limit to prevent excessive API calls

    do {
      let apiUrl = `https://www.googleapis.com/youtube/v3/commentThreads?part=snippet&videoId=${videoId}&maxResults=${maxResults}&key=${YOUTUBE_API_KEY}`;
      if (pageToken) {
        apiUrl += `&pageToken=${pageToken}`;
      }

      const youtubeResponse = await fetch(apiUrl);
      const youtubeData = await youtubeResponse.json();

      if (!youtubeResponse.ok) {
        console.error("YouTube API responded with error:", youtubeData);
        return res.status(youtubeResponse.status).json({
          message: youtubeData.error
            ? youtubeData.error.message
            : "Error from YouTube API",
          details: youtubeData.error ? youtubeData.error.errors : null,
          videoCategory: videoCategory,
        });
      }

      if (youtubeData.items && youtubeData.items.length > 0) {
        const commentsToAdd = youtubeData.items
          .map((item) => {
            return item.snippet.topLevelComment.snippet.textOriginal;
          })
          .filter((text) => text);

        allComments = allComments.concat(commentsToAdd);
        fetchedCommentCount += commentsToAdd.length;
      }

      pageToken = youtubeData.nextPageToken;

      // Add a small delay to avoid hitting YouTube API rate limits too quickly
      if (pageToken && fetchedCommentCount < maxCommentsToFetch) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    } while (pageToken && fetchedCommentCount < maxCommentsToFetch);

    if (allComments.length === 0) {
      return res.status(200).json({
        message: "No comments found or fetched.",
        comments: [],
        videoCategory: videoCategory,
        themes: [],
      });
    }

    // --- Perform Sentiment and Entity Analysis CONCURRENTLY using Promise.allSettled ---
    const analysisPromises = allComments.map(async (commentText) => {
      let sentiment = { score: null, magnitude: null };
      let entities = [];
      let commentError = null;

      try {
        const document = {
          content: commentText,
          type: "PLAIN_TEXT",
        };

        const [sentimentResult, entityResult] = await Promise.allSettled([
          languageClient.analyzeSentiment({ document: document }),
          languageClient.analyzeEntities({ document: document }),
        ]);

        // Process Sentiment Analysis Result
        if (sentimentResult.status === "fulfilled") {
          sentiment = sentimentResult.value[0].documentSentiment;
        } else {
          commentError = sentimentResult.reason.message;
          console.warn(
            `Sentiment analysis failed for comment: "${commentText}". Error: ${commentError}`
          );
        }

        // Process Entity Analysis Result
        if (entityResult.status === "fulfilled") {
          entities = entityResult.value[0].entities.map((entity) => ({
            name: entity.name,
            type: entity.type,
            salience: entity.salience,
          }));
        } else {
          if (!commentError) commentError = entityResult.reason.message;
          console.warn(
            `Entity analysis failed for comment: "${commentText}". Error: ${entityResult.reason.message}`
          );
        }
      } catch (overallCommentAnalysisError) {
        commentError = overallCommentAnalysisError.message;
        console.warn(
          `Overall analysis setup failed for comment: "${commentText}". Error: ${commentError}`
        );
      }

      return {
        text: commentText,
        sentiment: sentiment,
        entities: entities,
        error: commentError,
      };
    });

    const commentsWithAnalysis = await Promise.all(analysisPromises);

    // --- Process Entities to Find Common Themes ---
    const themeCounts = {};
    const themeSentimentScores = {};
    const minSalienceForTheme = 0.05;
    const minThemeOccurrences = 2;

    commentsWithAnalysis.forEach((comment) => {
      if (
        comment.sentiment &&
        typeof comment.sentiment.score === "number" &&
        !isNaN(comment.sentiment.score) &&
        comment.entities &&
        comment.entities.length > 0
      ) {
        comment.entities.forEach((entity) => {
          if (
            [
              "WORK_OF_ART",
              "CONSUMER_GOOD",
              "OTHER",
              "EVENT",
              "PRODUCT",
              "UNKNOWN",
            ].includes(entity.type) &&
            entity.salience > minSalienceForTheme
          ) {
            const themeName = entity.name.toLowerCase();

            themeCounts[themeName] = (themeCounts[themeName] || 0) + 1;
            themeSentimentScores[themeName] = themeSentimentScores[
              themeName
            ] || { sum: 0, count: 0 };
            themeSentimentScores[themeName].sum += comment.sentiment.score;
            themeSentimentScores[themeName].count++;
          }
        });
      }
    });

    const commonThemes = [];
    for (const theme in themeCounts) {
      if (themeCounts[theme] >= minThemeOccurrences) {
        const avgSentiment =
          themeSentimentScores[theme].count > 0
            ? themeSentimentScores[theme].sum /
              themeSentimentScores[theme].count
            : 0;
        let sentimentCategory = "neutral";
        if (avgSentiment > 0.2) sentimentCategory = "positive";
        else if (avgSentiment < -0.2) sentimentCategory = "negative";

        commonThemes.push({
          name: theme,
          occurrences: themeCounts[theme],
          averageSentiment: avgSentiment.toFixed(2),
          sentimentCategory: sentimentCategory,
        });
      }
    }

    commonThemes.sort((a, b) => b.occurrences - a.occurrences);

    res.status(200).json({
      message: `Successfully fetched and analyzed ${commentsWithAnalysis.length} comments.`,
      comments: commentsWithAnalysis,
      videoCategory: videoCategory,
      themes: commonThemes.slice(0, 5),
    });
  } catch (error) {
    console.error(
      "Error in backend comment fetch or overall analysis process:",
      error
    );
    res.status(500).json({
      message: "Internal Server Error",
      error: error.message,
      videoCategory: videoCategory,
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
